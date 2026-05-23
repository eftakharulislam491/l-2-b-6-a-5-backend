import httpStatus from "http-status-codes";
import { Prisma } from "../../../../generated/prisma/client";
import AppError from "../../helper/AppError";
import { prisma } from "../../lib/prisma";
import type {
  IAddCartItemPayload,
  IUpdateCartItemPayload,
} from "./cart.interface";

const cartProductSelect = {
  id: true,
  title: true,
  slug: true,
  price: true,
  isActive: true,
  hasVariants: true,
  images: {
    where: {
      isPrimary: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 1,
    select: {
      id: true,
      src: true,
      altText: true,
      sortOrder: true,
      isPrimary: true,
    },
  },
} satisfies Prisma.ProductSelect;

const cartOptionSelect = {
  id: true,
  productVariantId: true,
  sku: true,
  price: true,
  stock: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  variant: {
    select: {
      id: true,
      title: true,
      productId: true,
      isActive: true,
    },
  },
} satisfies Prisma.VariantOptionSelect;

const cartItemSelect = {
  id: true,
  cartId: true,
  productId: true,
  variantOptionId: true,
  variantOptionIds: true,
  selectionKey: true,
  quantity: true,
  createdAt: true,
  updatedAt: true,
  product: {
    select: cartProductSelect,
  },
  option: {
    select: cartOptionSelect,
  },
} satisfies Prisma.CartItemSelect;

const cartSelect = {
  id: true,
  userId: true,
  totalPrice: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: [{ createdAt: "asc" }],
    select: cartItemSelect,
  },
} satisfies Prisma.CartSelect;

type TCart = Prisma.CartGetPayload<{ select: typeof cartSelect }>;
type TCartItem = Prisma.CartItemGetPayload<{ select: typeof cartItemSelect }>;
type TVariantOption = Prisma.VariantOptionGetPayload<{
  select: typeof cartOptionSelect;
}>;

interface IResolvedSelection {
  product: Prisma.ProductGetPayload<{ select: typeof cartProductSelect }>;
  optionIds: string[];
  primaryOptionId: string;
  selectionKey: string;
  options: TVariantOption[];
}

const decimalFrom = (value: Prisma.Decimal | number | null | undefined) => {
  if (value instanceof Prisma.Decimal) {
    return value;
  }

  if (value === null || value === undefined) {
    return new Prisma.Decimal(0);
  }

  return new Prisma.Decimal(value);
};

const normalizeOptionIds = (optionIds: string[]) =>
  [...new Set(optionIds.map((id) => id.trim()).filter(Boolean))].sort();

const resolveRequestedOptionIds = (payload: IAddCartItemPayload) =>
  normalizeOptionIds([
    ...(payload.optionIds ?? []),
    ...(payload.variantOptionIds ?? []),
    ...(payload.variantOptionId ? [payload.variantOptionId] : []),
  ]);

const getCartItemOptionIds = (item: {
  variantOptionId: string;
  variantOptionIds: string[];
}) =>
  normalizeOptionIds(
    item.variantOptionIds.length ? item.variantOptionIds : [item.variantOptionId],
  );

const buildSelectionKey = (productId: string, optionIds: string[]) =>
  `${productId}::${optionIds.join("|")}`;

const ensureCart = async (tx: Prisma.TransactionClient, userId: string) => {
  const cart = await tx.cart.upsert({
    where: {
      userId,
    },
    update: {},
    create: {
      userId,
      totalPrice: new Prisma.Decimal(0),
    },
    select: {
      id: true,
      userId: true,
    },
  });

  return cart;
};

const calculateUnitPrice = (
  productPrice: Prisma.Decimal | null,
  options: TVariantOption[],
) => {
  if (productPrice === null) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Product base price is missing for selected cart item",
    );
  }

  const basePrice = decimalFrom(productPrice);
  const optionsPrice = options.reduce(
    (total, option) => total.add(decimalFrom(option.price)),
    new Prisma.Decimal(0),
  );

  return basePrice.add(optionsPrice);
};

const ensureSelectionStock = (options: TVariantOption[], requiredQuantity: number) => {
  for (const option of options) {
    if (option.stock < requiredQuantity) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for SKU '${option.sku}'`,
      );
    }
  }
};

const resolveSelection = async (
  tx: Prisma.TransactionClient,
  payload: IAddCartItemPayload,
): Promise<IResolvedSelection> => {
  const optionIds = resolveRequestedOptionIds(payload);

  if (!optionIds.length) {
    throw new AppError(httpStatus.BAD_REQUEST, "At least one optionId is required");
  }

  const product = await tx.product.findUnique({
    where: {
      id: payload.productId,
    },
    select: cartProductSelect,
  });

  if (!product) {
    throw new AppError(httpStatus.NOT_FOUND, "Product not found");
  }

  if (!product.isActive) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Product '${product.title}' is inactive`,
    );
  }

  if (product.price === null) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Base price is missing for product '${product.title}'`,
    );
  }

  const options = await tx.variantOption.findMany({
    where: {
      id: {
        in: optionIds,
      },
    },
    select: cartOptionSelect,
  });

  if (options.length !== optionIds.length) {
    throw new AppError(httpStatus.NOT_FOUND, "One or more selected options were not found");
  }

  const optionById = new Map(options.map((option) => [option.id, option]));
  const normalizedOptions = optionIds.map((optionId) => {
    const option = optionById.get(optionId);

    if (!option) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        `Selected option '${optionId}' was not found`,
      );
    }

    return option;
  });

  const variantIds = new Set<string>();

  for (const option of normalizedOptions) {
    if (option.variant.productId !== payload.productId) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "All selected options must belong to the same product",
      );
    }

    if (!option.variant.isActive) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Variant '${option.variant.title}' is inactive`,
      );
    }

    if (!option.isActive) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Variant option '${option.sku}' is inactive`,
      );
    }

    if (variantIds.has(option.productVariantId)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Only one option can be selected from each variant",
      );
    }

    variantIds.add(option.productVariantId);
  }

  const primaryOptionId = optionIds[0]!;
  const selectionKey = buildSelectionKey(payload.productId, optionIds);

  return {
    product,
    optionIds,
    primaryOptionId,
    selectionKey,
    options: normalizedOptions,
  };
};

const loadCartWithItems = async (tx: Prisma.TransactionClient, userId: string) => {
  await ensureCart(tx, userId);

  const cart = await tx.cart.findUnique({
    where: {
      userId,
    },
    select: cartSelect,
  });

  if (!cart) {
    throw new AppError(httpStatus.NOT_FOUND, "Cart not found");
  }

  return cart;
};

const loadOptionsMapForCartItems = async (
  tx: Prisma.TransactionClient,
  items: TCartItem[],
) => {
  const uniqueOptionIds = [...new Set(items.flatMap((item) => getCartItemOptionIds(item)))];

  if (!uniqueOptionIds.length) {
    return new Map<string, TVariantOption>();
  }

  const options = await tx.variantOption.findMany({
    where: {
      id: {
        in: uniqueOptionIds,
      },
    },
    select: cartOptionSelect,
  });

  const optionById = new Map(options.map((option) => [option.id, option]));

  for (const optionId of uniqueOptionIds) {
    if (!optionById.has(optionId)) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        `Cart contains invalid option '${optionId}'`,
      );
    }
  }

  return optionById;
};

const buildCartResponse = (
  cart: TCart,
  optionById: Map<string, TVariantOption>,
) => {
  let totalPrice = new Prisma.Decimal(0);
  let totalQuantity = 0;

  const items = cart.items.map((item) => {
    const optionIds = getCartItemOptionIds(item);
    const selectedOptions = optionIds.map((optionId) => {
      const option = optionById.get(optionId);

      if (!option) {
        throw new AppError(
          httpStatus.NOT_FOUND,
          `Cart contains invalid option '${optionId}'`,
        );
      }

      return option;
    });

    const unitPrice = calculateUnitPrice(item.product.price, selectedOptions);
    const lineTotal = unitPrice.mul(item.quantity);
    totalQuantity += item.quantity;
    totalPrice = totalPrice.add(lineTotal);

    return {
      id: item.id,
      cartId: item.cartId,
      productId: item.productId,
      selectionKey:
        item.selectionKey || buildSelectionKey(item.productId, optionIds),
      quantity: item.quantity,
      variantOptionId: item.variantOptionId,
      variantOptionIds: optionIds,
      unitPrice,
      lineTotal,
      product: item.product,
      option: item.option,
      selectedOptions,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  const groupedMap = new Map<
    string,
    {
      productId: string;
      product: (typeof items)[number]["product"];
      quantity: number;
      totalPrice: Prisma.Decimal;
      items: (typeof items)[number][];
    }
  >();

  for (const item of items) {
    const group = groupedMap.get(item.productId);

    if (!group) {
      groupedMap.set(item.productId, {
        productId: item.productId,
        product: item.product,
        quantity: item.quantity,
        totalPrice: item.lineTotal,
        items: [item],
      });
      continue;
    }

    group.quantity += item.quantity;
    group.totalPrice = group.totalPrice.add(item.lineTotal);
    group.items.push(item);
  }

  const groupedByProduct = [...groupedMap.values()];

  return {
    id: cart.id,
    userId: cart.userId,
    totalPrice,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    summary: {
      itemsCount: items.length,
      totalQuantity,
      totalPrice,
    },
    items,
    groupedByProduct,
  };
};

const getSyncedCartResponse = async (
  tx: Prisma.TransactionClient,
  userId: string,
) => {
  const cart = await loadCartWithItems(tx, userId);
  const optionById = await loadOptionsMapForCartItems(tx, cart.items);
  const response = buildCartResponse(cart, optionById);

  if (!decimalFrom(cart.totalPrice).equals(response.totalPrice)) {
    const updatedCart = await tx.cart.update({
      where: {
        id: cart.id,
      },
      data: {
        totalPrice: response.totalPrice,
      },
      select: {
        updatedAt: true,
      },
    });

    return {
      ...response,
      updatedAt: updatedCart.updatedAt,
    };
  }

  return response;
};

const getMyCart = async (userId: string) =>
  prisma.$transaction(async (tx) => getSyncedCartResponse(tx, userId), {
    timeout: 15000,
    maxWait: 5000,
  });

const addItemToCart = async (userId: string, payload: IAddCartItemPayload) =>
  prisma.$transaction(async (tx) => {
    const cart = await ensureCart(tx, userId);
    const quantityToAdd = payload.quantity ?? 1;
    const resolvedSelection = await resolveSelection(tx, payload);

    let existingItem = await tx.cartItem.findFirst({
      where: {
        cartId: cart.id,
        selectionKey: resolvedSelection.selectionKey,
      },
      select: {
        id: true,
        quantity: true,
      },
    });

    // Fallback for older rows created before selectionKey/variantOptionIds were introduced.
    if (!existingItem && resolvedSelection.optionIds.length === 1) {
      existingItem = await tx.cartItem.findFirst({
        where: {
          cartId: cart.id,
          variantOptionId: resolvedSelection.primaryOptionId,
          selectionKey: "",
        },
        select: {
          id: true,
          quantity: true,
        },
      });
    }

    const targetQuantity = (existingItem?.quantity ?? 0) + quantityToAdd;
    ensureSelectionStock(resolvedSelection.options, targetQuantity);

    if (existingItem) {
      await tx.cartItem.update({
        where: {
          id: existingItem.id,
        },
        data: {
          quantity: targetQuantity,
          productId: payload.productId,
          variantOptionId: resolvedSelection.primaryOptionId,
          variantOptionIds: resolvedSelection.optionIds,
          selectionKey: resolvedSelection.selectionKey,
        },
      });
    } else {
      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          productId: payload.productId,
          variantOptionId: resolvedSelection.primaryOptionId,
          variantOptionIds: resolvedSelection.optionIds,
          selectionKey: resolvedSelection.selectionKey,
          quantity: quantityToAdd,
        },
      });
    }

    return getSyncedCartResponse(tx, userId);
  }, {
    timeout: 15000,
    maxWait: 5000,
  });

const updateCartItemQuantity = async (
  userId: string,
  itemId: string,
  payload: IUpdateCartItemPayload,
) =>
  prisma.$transaction(async (tx) => {
    const cartItem = await tx.cartItem.findFirst({
      where: {
        id: itemId,
        cart: {
          userId,
        },
      },
      select: {
        id: true,
        productId: true,
        variantOptionId: true,
        variantOptionIds: true,
      },
    });

    if (!cartItem) {
      throw new AppError(httpStatus.NOT_FOUND, "Cart item not found");
    }

    const optionIds = getCartItemOptionIds(cartItem);
    const options = await tx.variantOption.findMany({
      where: {
        id: {
          in: optionIds,
        },
      },
      select: cartOptionSelect,
    });

    if (options.length !== optionIds.length) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        "One or more selected options for this cart item were not found",
      );
    }

    const optionById = new Map(options.map((option) => [option.id, option]));
    const normalizedOptions = optionIds.map((optionId) => {
      const option = optionById.get(optionId);

      if (!option) {
        throw new AppError(
          httpStatus.NOT_FOUND,
          `Selected option '${optionId}' was not found`,
        );
      }

      return option;
    });

    for (const option of normalizedOptions) {
      if (option.variant.productId !== cartItem.productId) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "Cart item contains mismatched product and selected options",
        );
      }

      if (!option.variant.isActive) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Variant '${option.variant.title}' is inactive`,
        );
      }

      if (!option.isActive) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Variant option '${option.sku}' is inactive`,
        );
      }
    }

    ensureSelectionStock(normalizedOptions, payload.quantity);

    await tx.cartItem.update({
      where: {
        id: cartItem.id,
      },
      data: {
        quantity: payload.quantity,
        variantOptionId: optionIds[0]!,
        variantOptionIds: optionIds,
        selectionKey: buildSelectionKey(cartItem.productId, optionIds),
      },
    });

    return getSyncedCartResponse(tx, userId);
  }, {
    timeout: 15000,
    maxWait: 5000,
  });

const removeCartItem = async (userId: string, itemId: string) =>
  prisma.$transaction(async (tx) => {
    const cartItem = await tx.cartItem.findFirst({
      where: {
        id: itemId,
        cart: {
          userId,
        },
      },
      select: {
        id: true,
      },
    });

    if (!cartItem) {
      throw new AppError(httpStatus.NOT_FOUND, "Cart item not found");
    }

    await tx.cartItem.delete({
      where: {
        id: cartItem.id,
      },
    });

    return getSyncedCartResponse(tx, userId);
  }, {
    timeout: 15000,
    maxWait: 5000,
  });

const clearMyCart = async (userId: string) =>
  prisma.$transaction(async (tx) => {
    const cart = await ensureCart(tx, userId);

    await tx.cartItem.deleteMany({
      where: {
        cartId: cart.id,
      },
    });

    await tx.cart.update({
      where: {
        id: cart.id,
      },
      data: {
        totalPrice: new Prisma.Decimal(0),
      },
    });

    return getSyncedCartResponse(tx, userId);
  }, {
    timeout: 15000,
    maxWait: 5000,
  });

export const CartService = {
  getMyCart,
  addItemToCart,
  updateCartItemQuantity,
  removeCartItem,
  clearMyCart,
};
