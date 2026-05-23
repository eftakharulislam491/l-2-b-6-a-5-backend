import { randomUUID } from "crypto";
import httpStatus from "http-status-codes";
import { Prisma } from "../../../../generated/prisma/client";
import AppError from "../../helper/AppError";
import { prisma } from "../../lib/prisma";
import { PaymentService } from "../payment/payment.service";
import type {
  TOrderStatus,
  TPaymentMethod,
  TPaymentStatus,
} from "../payment/payment.interface";
import type {
  ICreateOrderPayload,
  IOrderQuery,
  IUpdateOrderStatusPayload,
} from "./order.interface";

const orderStatusValues = [
  "PENDING",
  "PROCESSING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "RETURNED",
  "REFUNDED",
] as const satisfies readonly TOrderStatus[];

const paymentStatusValues = [
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "REFUNDED",
] as const satisfies readonly TPaymentStatus[];

const paymentMethodValues = [
  "CASH_ON_DELIVERY",
  "STRIPE",
  "BKASH",
  "NAGAD",
  "ROCKET",
  "CREDIT_CARD",
  "BANK_TRANSFER",
] as const satisfies readonly TPaymentMethod[];

const orderStatusSet = new Set<TOrderStatus>(orderStatusValues);
const paymentStatusSet = new Set<TPaymentStatus>(paymentStatusValues);
const paymentMethodSet = new Set<TPaymentMethod>(paymentMethodValues);

const orderPaymentSelect = {
  id: true,
  method: true,
  status: true,
  amount: true,
  transactionId: true,
  paidAt: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentSelect;

const orderItemSelect = {
  id: true,
  orderId: true,
  variantOptionId: true,
  variantOptionIds: true,
  productId: true,
  productName: true,
  productSku: true,
  productImage: true,
  variantSnapshot: true,
  quantity: true,
  unitPrice: true,
  discountAmount: true,
  total: true,
  createdAt: true,
  option: {
    select: {
      id: true,
      productVariantId: true,
      sku: true,
      price: true,
      stock: true,
      isActive: true,
      variant: {
        select: {
          id: true,
          title: true,
          productId: true,
          isActive: true,
        },
      },
    },
  },
} satisfies Prisma.OrderItemSelect;

const orderSelect = {
  id: true,
  orderNumber: true,
  userId: true,
  shippingAddressId: true,
  billingAddress: true,
  status: true,
  notes: true,
  adminNotes: true,
  subtotal: true,
  discountTotal: true,
  shippingCost: true,
  tax: true,
  total: true,
  couponId: true,
  couponCode: true,
  placedAt: true,
  processedAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  returnedAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
    },
  },
  address: {
    select: {
      id: true,
      label: true,
      recipient: true,
      phone: true,
      street: true,
      city: true,
      state: true,
      zipCode: true,
      country: true,
    },
  },
  items: {
    orderBy: [{ createdAt: "asc" }],
    select: orderItemSelect,
  },
  payment: {
    select: orderPaymentSelect,
  },
  statusHistory: {
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      note: true,
      changedBy: true,
      createdAt: true,
    },
  },
} satisfies Prisma.OrderSelect;

const createOrderCartSelect = {
  id: true,
  userId: true,
  items: {
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      productId: true,
      variantOptionId: true,
      variantOptionIds: true,
      quantity: true,
      product: {
        select: {
          id: true,
          title: true,
          slug: true,
          price: true,
          isActive: true,
          images: {
            where: { isPrimary: true },
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            take: 1,
            select: {
              id: true,
              src: true,
            },
          },
        },
      },
      option: {
        select: {
          id: true,
          productVariantId: true,
          sku: true,
          price: true,
          stock: true,
          isActive: true,
          variant: {
            select: {
              id: true,
              title: true,
              productId: true,
              isActive: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CartSelect;

type TOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
type TCreateOrderCart = Prisma.CartGetPayload<{ select: typeof createOrderCartSelect }>;
type TCreateOrderCartOption = TCreateOrderCart["items"][number]["option"];

interface IPreparedOrderItem {
  productId: string;
  variantOptionId: string;
  variantOptionIds: string[];
  quantity: number;
  productName: string;
  productSku: string;
  productImage: string | null;
  variantSnapshot: Prisma.InputJsonValue;
  unitPrice: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  stockAdjustments: {
    variantOptionId: string;
    sku: string;
    previousStock: number;
  }[];
}

const orderStatusTransitions: Record<TOrderStatus, TOrderStatus[]> = {
  PENDING: ["PROCESSING", "CONFIRMED", "CANCELLED"],
  PROCESSING: ["CONFIRMED", "SHIPPED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED", "REFUNDED"],
  CANCELLED: [],
  RETURNED: ["REFUNDED"],
  REFUNDED: [],
};

const orderSortableFields = ["createdAt", "placedAt", "total", "status"] as const;
const writeTransactionOptions = {
  maxWait: 10_000,
  timeout: 60_000,
};
const MAX_CREATE_ORDER_TRANSACTION_ATTEMPTS = 2;
const RETRYABLE_ORDER_TRANSACTION_ERROR_PATTERN =
  /expired transaction|transaction api error|interactive transaction timeout|timed out|transaction already closed/i;

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

const getCartItemOptionIds = (item: {
  variantOptionId: string;
  variantOptionIds: string[];
}) =>
  normalizeOptionIds(
    item.variantOptionIds.length ? item.variantOptionIds : [item.variantOptionId],
  );

const parseOrderStatus = (value: string, key: string): TOrderStatus => {
  const normalized = value.trim().toUpperCase() as TOrderStatus;

  if (!orderStatusSet.has(normalized)) {
    throw new AppError(httpStatus.BAD_REQUEST, `${key} has an invalid value`);
  }

  return normalized;
};

const parsePaymentStatus = (value: string): TPaymentStatus => {
  const normalized = value.trim().toUpperCase() as TPaymentStatus;

  if (!paymentStatusSet.has(normalized)) {
    throw new AppError(httpStatus.BAD_REQUEST, "paymentStatus has an invalid value");
  }

  return normalized;
};

const parsePaymentMethod = (value: string): TPaymentMethod => {
  const normalized = value.trim().toUpperCase() as TPaymentMethod;

  if (!paymentMethodSet.has(normalized)) {
    throw new AppError(httpStatus.BAD_REQUEST, "paymentMethod has an invalid value");
  }

  return normalized;
};

const parseDateQuery = (value: string | undefined, key: string) => {
  if (!value) {
    return undefined;
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    throw new AppError(httpStatus.BAD_REQUEST, `${key} must be a valid date`);
  }

  return parsedDate;
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isRetryableOrderTransactionError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return RETRYABLE_ORDER_TRANSACTION_ERROR_PATTERN.test(error.message);
};

const getPagination = (query: IOrderQuery) => {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

const buildOrderBy = (sort: string | undefined): Prisma.OrderOrderByWithRelationInput[] => {
  if (!sort?.trim()) {
    return [{ placedAt: "desc" }];
  }

  const orderBy = sort
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      const direction = field.startsWith("-") ? "desc" : "asc";
      const normalizedField = field.replace(/^-/, "");

      if (!orderSortableFields.includes(normalizedField as (typeof orderSortableFields)[number])) {
        return null;
      }

      return {
        [normalizedField]: direction,
      } as Prisma.OrderOrderByWithRelationInput;
    })
    .filter((value): value is Prisma.OrderOrderByWithRelationInput => value !== null);

  if (!orderBy.length) {
    return [{ placedAt: "desc" }];
  }

  return orderBy;
};

const buildOrderWhere = (
  query: IOrderQuery,
  userId?: string,
): Prisma.OrderWhereInput => {
  const where: Prisma.OrderWhereInput = {};
  const paymentWhere: Prisma.PaymentWhereInput = {};

  if (userId) {
    where.userId = userId;
  }

  if (query.userId && !userId) {
    where.userId = query.userId;
  }

  if (query.status) {
    where.status = parseOrderStatus(query.status, "status");
  }

  if (query.paymentStatus) {
    paymentWhere.status = parsePaymentStatus(query.paymentStatus);
  }

  if (query.paymentMethod) {
    paymentWhere.method = parsePaymentMethod(query.paymentMethod);
  }

  if (Object.keys(paymentWhere).length > 0) {
    where.payment = {
      is: paymentWhere,
    };
  }

  const fromDate = parseDateQuery(query.fromDate, "fromDate");
  const toDate = parseDateQuery(query.toDate, "toDate");

  if (fromDate || toDate) {
    where.placedAt = {
      ...(fromDate && { gte: fromDate }),
      ...(toDate && { lte: toDate }),
    };
  }

  if (query.searchTerm?.trim()) {
    const searchTerm = query.searchTerm.trim();

    where.OR = [
      {
        orderNumber: {
          contains: searchTerm,
          mode: "insensitive",
        },
      },
      {
        couponCode: {
          contains: searchTerm,
          mode: "insensitive",
        },
      },
      {
        items: {
          some: {
            productName: {
              contains: searchTerm,
              mode: "insensitive",
            },
          },
        },
      },
    ];
  }

  return where;
};

const generateOrderNumber = () => {
  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomSuffix = randomUUID().split("-")[0]?.toUpperCase() ?? "00000000";

  return `ORD-${datePrefix}-${randomSuffix}`;
};

const getUniqueOrderNumber = async (tx: Prisma.TransactionClient) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const orderNumber = generateOrderNumber();
    const existing = await tx.order.findUnique({
      where: { orderNumber },
      select: { id: true },
    });

    if (!existing) {
      return orderNumber;
    }
  }

  throw new AppError(
    httpStatus.SERVICE_UNAVAILABLE,
    "Unable to generate unique order number",
  );
};

const ensureShippingAddressBelongsToUser = async (
  tx: Prisma.TransactionClient,
  userId: string,
  shippingAddressId: string,
) => {
  const address = await tx.address.findFirst({
    where: {
      id: shippingAddressId,
      userId,
    },
    select: {
      id: true,
    },
  });

  if (!address) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "Shipping address not found for this user",
    );
  }
};

const validateAndPrepareOrderItems = async (
  tx: Prisma.TransactionClient,
  cart: TCreateOrderCart,
) => {
  if (!cart.items.length) {
    throw new AppError(httpStatus.BAD_REQUEST, "Cart is empty");
  }

  const uniqueOptionIds = [
    ...new Set(cart.items.flatMap((item) => getCartItemOptionIds(item))),
  ];

  const options = await tx.variantOption.findMany({
    where: {
      id: {
        in: uniqueOptionIds,
      },
    },
    select: {
      id: true,
      productVariantId: true,
      sku: true,
      price: true,
      stock: true,
      isActive: true,
      variant: {
        select: {
          id: true,
          title: true,
          productId: true,
          isActive: true,
        },
      },
    },
  });

  if (options.length !== uniqueOptionIds.length) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "One or more selected variant options were not found in cart items",
    );
  }

  const optionById = new Map<string, TCreateOrderCartOption>(
    options.map((option) => [option.id, option]),
  );

  let subtotal = new Prisma.Decimal(0);

  const preparedItems = cart.items.map((item): IPreparedOrderItem => {
    if (!item.product.isActive) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Product '${item.product.title}' is inactive`,
      );
    }

    if (item.product.price === null) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Base price is missing for product '${item.product.title}'`,
      );
    }

    const selectedOptionIds = getCartItemOptionIds(item);
    const selectedOptions = selectedOptionIds.map((optionId) => {
      const option = optionById.get(optionId);

      if (!option) {
        throw new AppError(
          httpStatus.NOT_FOUND,
          `Selected option '${optionId}' was not found`,
        );
      }

      return option;
    });

    const seenVariantIds = new Set<string>();

    for (const selectedOption of selectedOptions) {
      if (selectedOption.variant.productId !== item.productId) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "Cart item contains mismatched product and selected options",
        );
      }

      if (!selectedOption.variant.isActive) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Variant '${selectedOption.variant.title}' is inactive`,
        );
      }

      if (!selectedOption.isActive) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Variant option '${selectedOption.sku}' is inactive`,
        );
      }

      if (selectedOption.stock < item.quantity) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Insufficient stock for SKU '${selectedOption.sku}'`,
        );
      }

      if (seenVariantIds.has(selectedOption.productVariantId)) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "Cart item contains multiple options from the same variant",
        );
      }

      seenVariantIds.add(selectedOption.productVariantId);
    }

    const primaryOption =
      selectedOptions.find((option) => option.id === item.variantOptionId) ??
      selectedOptions[0];

    if (!primaryOption) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Cart item does not contain any selected option",
      );
    }

    const basePrice = decimalFrom(item.product.price);
    const variantAdditionalPrice = selectedOptions.reduce(
      (total, option) => total.add(decimalFrom(option.price)),
      new Prisma.Decimal(0),
    );
    const unitPrice = basePrice.add(variantAdditionalPrice);
    const total = unitPrice.mul(item.quantity);
    subtotal = subtotal.add(total);

    return {
      productId: item.product.id,
      variantOptionId: primaryOption.id,
      variantOptionIds: selectedOptionIds,
      quantity: item.quantity,
      productName: item.product.title,
      productSku: selectedOptions.map((option) => option.sku).join(" | "),
      productImage: item.product.images[0]?.src ?? null,
      variantSnapshot: {
        selectedOptions: selectedOptions.map((option) => ({
          variantId: option.variant.id,
          variantTitle: option.variant.title,
          optionId: option.id,
          optionSku: option.sku,
          price: decimalFrom(option.price).toString(),
        })),
        primarySelection: {
          variantId: primaryOption.variant.id,
          variantTitle: primaryOption.variant.title,
          optionId: primaryOption.id,
          optionSku: primaryOption.sku,
        },
      } as Prisma.InputJsonValue,
      unitPrice,
      discountAmount: new Prisma.Decimal(0),
      total,
      stockAdjustments: selectedOptions.map((option) => ({
        variantOptionId: option.id,
        sku: option.sku,
        previousStock: option.stock,
      })),
    };
  });

  return {
    preparedItems,
    subtotal,
  };
};

const clearCartAfterOrder = async (tx: Prisma.TransactionClient, cartId: string) => {
  await tx.cartItem.deleteMany({
    where: {
      cartId,
    },
  });

  await tx.cart.update({
    where: { id: cartId },
    data: {
      totalPrice: new Prisma.Decimal(0),
    },
  });
};

const restockOrderItems = async (
  tx: Prisma.TransactionClient,
  orderId: string,
  orderNumber: string,
  items: { variantOptionId: string; variantOptionIds: string[]; quantity: number }[],
  type: "CANCELLATION" | "RETURN",
  changedBy: string,
) => {
  const restockQuantityByOptionId = new Map<string, number>();

  for (const item of items) {
    const optionIds = getCartItemOptionIds(item);

    for (const optionId of optionIds) {
      restockQuantityByOptionId.set(
        optionId,
        (restockQuantityByOptionId.get(optionId) ?? 0) + item.quantity,
      );
    }
  }

  const optionIds = [...restockQuantityByOptionId.keys()];

  if (!optionIds.length) {
    return;
  }

  const options = await tx.variantOption.findMany({
    where: {
      id: {
        in: optionIds,
      },
    },
    select: {
      id: true,
      stock: true,
    },
  });

  if (options.length !== optionIds.length) {
    throw new AppError(httpStatus.NOT_FOUND, "Variant option not found");
  }

  const optionById = new Map(options.map((option) => [option.id, option]));
  const inventoryRows: Prisma.InventoryTransactionCreateManyInput[] = [];

  for (const optionId of optionIds) {
    const option = optionById.get(optionId);
    const quantity = restockQuantityByOptionId.get(optionId) ?? 0;

    if (!option) {
      throw new AppError(httpStatus.NOT_FOUND, "Variant option not found");
    }

    const previousStock = option.stock;
    const newStock = previousStock + quantity;

    await tx.variantOption.update({
      where: { id: option.id },
      data: {
        stock: {
          increment: quantity,
        },
      },
    });

    inventoryRows.push({
      variantOptionId: option.id,
      type,
      quantity,
      previousStock,
      newStock,
      referenceId: orderId,
      referenceType: "order",
      note: `Stock restored due to ${type.toLowerCase()} for order ${orderNumber}`,
      createdBy: changedBy,
    });
  }

  if (inventoryRows.length) {
    await tx.inventoryTransaction.createMany({
      data: inventoryRows,
    });
  }
};

const createOrderFromCart = async (userId: string, payload: ICreateOrderPayload) => {
  const executeCreateOrderTransaction = () =>
    prisma.$transaction(async (tx) => {
    const isCashOnDelivery = payload.paymentMethod === "CASH_ON_DELIVERY";

    await ensureShippingAddressBelongsToUser(tx, userId, payload.shippingAddressId);

    if (!isCashOnDelivery) {
      const existingPendingOnlineOrder = await tx.order.findFirst({
        where: {
          userId,
          status: "PENDING",
          payment: {
            is: {
              method: {
                not: "CASH_ON_DELIVERY",
              },
              status: {
                in: ["PENDING", "PROCESSING"],
              },
            },
          },
        },
        select: {
          orderNumber: true,
        },
      });

      if (existingPendingOnlineOrder) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `You already have an unpaid online order (${existingPendingOnlineOrder.orderNumber}). Complete or cancel it before creating a new one.`,
        );
      }
    }

    const cart = await tx.cart.findUnique({
      where: {
        userId,
      },
      select: createOrderCartSelect,
    });

    if (!cart) {
      throw new AppError(httpStatus.BAD_REQUEST, "Cart is empty");
    }

    const { preparedItems, subtotal } = await validateAndPrepareOrderItems(tx, cart);
    const discountTotal = new Prisma.Decimal(0);
    const shippingCost = decimalFrom(payload.shippingCost ?? 0);
    const tax = decimalFrom(payload.tax ?? 0);
    const total = subtotal.sub(discountTotal).add(shippingCost).add(tax);
    const orderNumber = await getUniqueOrderNumber(tx);

    const createdOrder = await tx.order.create({
      data: {
        orderNumber,
        userId,
        shippingAddressId: payload.shippingAddressId,
        ...(payload.billingAddress && {
          billingAddress: payload.billingAddress as Prisma.InputJsonValue,
        }),
        status: "PENDING",
        notes: payload.notes ?? null,
        subtotal,
        discountTotal,
        shippingCost,
        tax,
        total,
      },
      select: {
        id: true,
        orderNumber: true,
      },
    });

    await tx.orderItem.createMany({
      data: preparedItems.map((item) => ({
        orderId: createdOrder.id,
        variantOptionId: item.variantOptionId,
        variantOptionIds: item.variantOptionIds,
        productId: item.productId,
        productName: item.productName,
        productSku: item.productSku,
        productImage: item.productImage,
        variantSnapshot: item.variantSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        total: item.total,
      })),
    });

    if (isCashOnDelivery) {
      const stockAdjustmentsByOptionId = new Map<
        string,
        { sku: string; previousStock: number; quantity: number }
      >();

      for (const item of preparedItems) {
        for (const stockAdjustment of item.stockAdjustments) {
          const existingAdjustment = stockAdjustmentsByOptionId.get(
            stockAdjustment.variantOptionId,
          );

          if (existingAdjustment) {
            existingAdjustment.quantity += item.quantity;
            continue;
          }

          stockAdjustmentsByOptionId.set(stockAdjustment.variantOptionId, {
            sku: stockAdjustment.sku,
            previousStock: stockAdjustment.previousStock,
            quantity: item.quantity,
          });
        }
      }

      const inventoryRows: Prisma.InventoryTransactionCreateManyInput[] = [];

      for (const [variantOptionId, stockAdjustment] of stockAdjustmentsByOptionId.entries()) {
        const updated = await tx.variantOption.updateMany({
          where: {
            id: variantOptionId,
            stock: {
              gte: stockAdjustment.quantity,
            },
          },
          data: {
            stock: {
              decrement: stockAdjustment.quantity,
            },
          },
        });

        if (updated.count === 0) {
          throw new AppError(
            httpStatus.BAD_REQUEST,
            `Insufficient stock for SKU '${stockAdjustment.sku}'`,
          );
        }

        inventoryRows.push({
          variantOptionId,
          type: "SALE",
          quantity: -stockAdjustment.quantity,
          previousStock: stockAdjustment.previousStock,
          newStock: stockAdjustment.previousStock - stockAdjustment.quantity,
          referenceId: createdOrder.id,
          referenceType: "order",
          note: `Stock deducted for order ${createdOrder.orderNumber}`,
          createdBy: userId,
        });
      }

      if (inventoryRows.length) {
        await tx.inventoryTransaction.createMany({
          data: inventoryRows,
        });
      }
    }

    await PaymentService.createOrderPayment(tx, {
      orderId: createdOrder.id,
      method: payload.paymentMethod,
      amount: total,
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId: createdOrder.id,
        status: "PENDING",
        note: isCashOnDelivery
          ? "Order placed (cash on delivery)"
          : "Order created and awaiting payment confirmation",
        changedBy: userId,
      },
    });

    if (isCashOnDelivery) {
      await clearCartAfterOrder(tx, cart.id);
    }

      return createdOrder.id;
    }, writeTransactionOptions);

  let createdOrderId: string | null = null;

  for (
    let attempt = 1;
    attempt <= MAX_CREATE_ORDER_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      createdOrderId = await executeCreateOrderTransaction();
      break;
    } catch (error) {
      const shouldRetry =
        attempt < MAX_CREATE_ORDER_TRANSACTION_ATTEMPTS &&
        isRetryableOrderTransactionError(error);

      if (shouldRetry) {
        await wait(250 * attempt);
        continue;
      }

      throw error;
    }
  }

  if (!createdOrderId) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "Unable to create order right now. Please try again.",
    );
  }

  const order = await prisma.order.findUnique({
    where: {
      id: createdOrderId,
    },
    select: orderSelect,
  });

  if (!order) {
    throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  }

  if (payload.paymentMethod === "CASH_ON_DELIVERY") {
    void PaymentService.sendInvoiceEmailForOrder(createdOrderId).catch((error) => {
      console.error("Failed to send COD invoice email", error);
    });
  }

  return order;
};

const getMyOrders = async (userId: string, query: IOrderQuery) => {
  const { page, limit, skip } = getPagination(query);
  const where = buildOrderWhere(query, userId);

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: buildOrderBy(query.sort),
      skip,
      take: limit,
      select: orderSelect,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    data,
  };
};

const getMyOrderById = async (userId: string, orderId: string) => {
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      userId,
    },
    select: orderSelect,
  });

  if (!order) {
    throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  }

  return order;
};

const getAllOrders = async (query: IOrderQuery) => {
  const { page, limit, skip } = getPagination(query);
  const where = buildOrderWhere(query);

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: buildOrderBy(query.sort),
      skip,
      take: limit,
      select: orderSelect,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    data,
  };
};

const getOrderByIdForAdmin = async (orderId: string) => {
  const order = await prisma.order.findUnique({
    where: {
      id: orderId,
    },
    select: orderSelect,
  });

  if (!order) {
    throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  }

  return order;
};

const ensureStatusTransition = (
  currentStatus: TOrderStatus,
  nextStatus: TOrderStatus,
) => {
  if (currentStatus === nextStatus) {
    throw new AppError(httpStatus.BAD_REQUEST, "Order already has this status");
  }

  const allowedNextStatuses = orderStatusTransitions[currentStatus];

  if (!allowedNextStatuses.includes(nextStatus)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Cannot transition order status from ${currentStatus} to ${nextStatus}`,
    );
  }
};

const updateOrderStatus = async (
  orderId: string,
  payload: IUpdateOrderStatusPayload,
  changedBy: string,
) => {
  const updatedOrderId = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: {
        id: orderId,
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        payment: {
          select: {
            method: true,
            status: true,
          },
        },
        items: {
          select: {
            variantOptionId: true,
            variantOptionIds: true,
            quantity: true,
          },
        },
      },
    });

    if (!order) {
      throw new AppError(httpStatus.NOT_FOUND, "Order not found");
    }

    const currentStatus = order.status as TOrderStatus;
    ensureStatusTransition(currentStatus, payload.status);

    const payment = order.payment;
    const isOnlineUnpaidOrder =
      payment !== null &&
      payment.method !== "CASH_ON_DELIVERY" &&
      payment.status !== "SUCCESS";

    if (isOnlineUnpaidOrder && payload.status !== "CANCELLED") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Online order cannot change status before payment is completed",
      );
    }

    const now = new Date();
    const updateData: Prisma.OrderUncheckedUpdateInput = {
      status: payload.status,
    };

    if (payload.status === "PROCESSING") {
      updateData.processedAt = now;
    }

    if (payload.status === "SHIPPED") {
      updateData.shippedAt = now;
    }

    if (payload.status === "DELIVERED") {
      updateData.deliveredAt = now;
    }

    if (payload.status === "CANCELLED") {
      updateData.cancelledAt = now;
    }

    if (payload.status === "RETURNED") {
      updateData.returnedAt = now;
    }

    await tx.order.update({
      where: { id: order.id },
      data: updateData,
    });

    if (payload.status === "CANCELLED" && !isOnlineUnpaidOrder) {
      await restockOrderItems(
        tx,
        order.id,
        order.orderNumber,
        order.items,
        "CANCELLATION",
        changedBy,
      );
    }

    if (payload.status === "RETURNED") {
      await restockOrderItems(
        tx,
        order.id,
        order.orderNumber,
        order.items,
        "RETURN",
        changedBy,
      );
    }

    await PaymentService.syncPaymentWithOrderStatus(tx, order.id, payload.status);

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        status: payload.status,
        note: payload.note ?? null,
        changedBy,
      },
    });

    return order.id;
  }, writeTransactionOptions);

  const updatedOrder = await prisma.order.findUnique({
    where: {
      id: updatedOrderId,
    },
    select: orderSelect,
  });

  if (!updatedOrder) {
    throw new AppError(httpStatus.NOT_FOUND, "Order not found");
  }

  return updatedOrder;
};

export const OrderService = {
  createOrderFromCart,
  getMyOrders,
  getMyOrderById,
  getAllOrders,
  getOrderByIdForAdmin,
  updateOrderStatus,
};
