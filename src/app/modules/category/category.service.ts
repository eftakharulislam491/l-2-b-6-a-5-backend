import httpStatus from "http-status-codes";
import type { Prisma } from "../../../../generated/prisma/client";
import AppError from "../../helper/AppError";
import { prisma } from "../../lib/prisma";
import { QueryBuilder } from "../../utils/QueryBuilder";
import { categorySearchableFields } from "./category.constant";
import type {
  ICollectionProduct,
  ICategoryCollectionNode,
  ICreateCategoryPayload,
  IUpdateCategoryPayload,
} from "./category.interface";

type PublicCollectionsResponse = {
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPage: number;
  };
  data: ICategoryCollectionNode[];
};

// ─── Cache ────────────────────────────────────────────────────────────────────

const PUBLIC_COLLECTIONS_CACHE_TTL_MS = 60_000;
const publicCollectionsCache = new Map<
  string,
  { expiresAt: number; value: PublicCollectionsResponse }
>();

// ─── Select shapes ────────────────────────────────────────────────────────────

const categoryImageSelect = {
  id: true,
  src: true,
  publicId: true,
  altText: true,
  sortOrder: true,
  isPrimary: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductImageSelect;

const categoryBaseSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  imageId: true,
  image: { select: categoryImageSelect },
  isActive: true,
  sortOrder: true,
  parentId: true,
  metaTitle: true,
  metaDescription: true,
  metaKeywords: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CategorySelect;

const categoryListSelect = {
  ...categoryBaseSelect,
  parent: { select: { id: true, name: true, slug: true } },
  _count: { select: { children: true, products: true } },
} satisfies Prisma.CategorySelect;

const categoryDetailsSelect = {
  ...categoryListSelect,
  children: {
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      sortOrder: true,
      parentId: true,
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  },
} satisfies Prisma.CategorySelect;

const collectionCategorySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  imageId: true,
  image: { select: categoryImageSelect },
  isActive: true,
  sortOrder: true,
  parentId: true,
} satisfies Prisma.CategorySelect;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parseProductLimit = (value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.min(Math.max(Math.floor(parsed), 1), 24);
};

const buildPublicCollectionsCacheKey = (
  query: Record<string, string | undefined>,
): string =>
  Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

const clearPublicCollectionsCache = (): void => {
  publicCollectionsCache.clear();
};

// ─── Guard helpers ────────────────────────────────────────────────────────────

const ensureParentExists = async (parentId: string): Promise<void> => {
  const parent = await prisma.category.findUnique({
    where: { id: parentId },
    select: { id: true },
  });
  if (!parent) {
    throw new AppError(httpStatus.NOT_FOUND, "Parent category not found");
  }
};

const ensureImageExists = async (imageId: string): Promise<void> => {
  const image = await prisma.productImage.findUnique({
    where: { id: imageId },
    select: { id: true },
  });
  if (!image) {
    throw new AppError(httpStatus.NOT_FOUND, "Image not found");
  }
};

const ensureSlugUnique = async (
  slug: string,
  excludedCategoryId?: string,
): Promise<void> => {
  const existing = await prisma.category.findFirst({
    where: {
      slug,
      ...(excludedCategoryId && { id: { not: excludedCategoryId } }),
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(httpStatus.CONFLICT, "Category slug already exists");
  }
};

const ensureNameUniqueWithinParent = async (
  name: string,
  parentId: string | null,
  excludedCategoryId?: string,
): Promise<void> => {
  const existing = await prisma.category.findFirst({
    where: {
      name,
      parentId,
      ...(excludedCategoryId && { id: { not: excludedCategoryId } }),
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      httpStatus.CONFLICT,
      "Category name already exists under this parent",
    );
  }
};

/**
 * OPTIMIZED: O(d) sequential queries → O(1) single recursive CTE.
 * Walks the entire ancestor chain of `nextParentId` in one DB round-trip
 * and checks whether `categoryId` appears anywhere in it.
 */
const ensureNoCircularParent = async (
  categoryId: string,
  nextParentId: string,
): Promise<void> => {
  const result = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, "parentId"
      FROM categories
      WHERE id = ${nextParentId}

      UNION ALL

      SELECT c.id, c."parentId"
      FROM categories c
      INNER JOIN ancestors a ON c.id = a."parentId"
    )
    SELECT id FROM ancestors WHERE id = ${categoryId} LIMIT 1
  `;

  if (result.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Circular parent relationship is not allowed",
    );
  }
};

const collectCategorySubtreeIds = async (
  rootCategoryId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> => {
  const categoryIds = new Set<string>([rootCategoryId]);
  let currentParentIds = [rootCategoryId];

  while (currentParentIds.length > 0) {
    const children = await tx.category.findMany({
      where: { parentId: { in: currentParentIds } },
      select: { id: true },
    });

    const nextParentIds: string[] = [];
    for (const child of children) {
      if (categoryIds.has(child.id)) continue;
      categoryIds.add(child.id);
      nextParentIds.push(child.id);
    }

    currentParentIds = nextParentIds;
  }

  return Array.from(categoryIds);
};

// ─── Query builders ───────────────────────────────────────────────────────────

const buildOrderBy = (
  sort: string | undefined,
): Prisma.CategoryOrderByWithRelationInput[] => {
  if (!sort) return [{ sortOrder: "asc" }, { createdAt: "desc" }];

  return sort
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) =>
      field.startsWith("-")
        ? { [field.slice(1)]: "desc" }
        : { [field]: "asc" },
    ) as Prisma.CategoryOrderByWithRelationInput[];
};

const buildWhere = (
  query: Record<string, string | undefined>,
): Prisma.CategoryWhereInput => {
  const where: Prisma.CategoryWhereInput = {};
  const searchTerm = query.searchTerm?.trim();
  const name = query.name?.trim();

  if (searchTerm) {
    where.OR = categorySearchableFields.map((field) => ({
      [field]: { contains: searchTerm, mode: "insensitive" },
    }));
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  if (query.parentId !== undefined) {
    const parentId = query.parentId.trim().toLowerCase();
    where.parentId =
      parentId === "" || parentId === "null" || parentId === "root"
        ? null
        : query.parentId.trim();
  }

  if (query.isActive !== undefined) {
    if (query.isActive !== "true" && query.isActive !== "false") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "isActive query must be true or false",
      );
    }
    where.isActive = query.isActive === "true";
  }

  return where;
};

// ─── Product assignment (OPTIMIZED) ──────────────────────────────────────────

/**
 * Raw product row returned by the LATERAL query.
 * Prisma's Decimal columns come back as strings over $queryRaw.
 */
type RawProductRow = {
  categoryId: string;
  id: string;
  title: string;
  slug: string;
  shortDesc: string | null;
  brand: string | null;
  price: string | null;
  compareAtPrice: string | null;
  hasVariants: boolean;
  isFeatured: boolean;
  imageId: string | null;
  imageSrc: string | null;
  imageAlt: string | null;
  imagePrimary: boolean | null;
};

/**
 * OPTIMIZED: r individual queries → 1 LATERAL join query.
 *
 * For each root category, fetches up to `productLimit` active products
 * ordered by (isFeatured DESC, createdAt DESC) — all in a single round-trip.
 *
 * Equivalent Prisma behaviour used previously would issue one SELECT per
 * category ID because Prisma cannot batch `take` on a nested relation over
 * an `IN` filter at the SQL level.
 */
const assignProductsToRoots = async (
  roots: ICategoryCollectionNode[],
  productLimit: number,
): Promise<void> => {
  if (!roots.length || productLimit <= 0) return;

  const rootIds = roots.map((r) => r.id);

  const rows = await prisma.$queryRaw<RawProductRow[]>`
    SELECT
      c.id            AS "categoryId",
      p.id,
      p.title,
      p.slug,
      p."shortDesc",
      p.brand,
      p.price::text,
      p."compareAtPrice"::text AS "compareAtPrice",
      p."hasVariants",
      p."isFeatured",
      pi.id           AS "imageId",
      pi.src          AS "imageSrc",
      pi."altText"    AS "imageAlt",
      pi."isPrimary"  AS "imagePrimary"
    FROM categories c
    JOIN LATERAL (
      SELECT
        pr.id,
        pr.title,
        pr.slug,
        pr."shortDesc",
        pr.brand,
        pr.price,
        pr."compareAtPrice",
        pr."hasVariants",
        pr."isFeatured",
        pr."categoryId"
      FROM products pr
      WHERE pr."categoryId" = c.id
        AND pr."isActive" = true
      ORDER BY pr."isFeatured" DESC, pr."createdAt" DESC
      LIMIT ${productLimit}
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT id, src, "altText", "isPrimary"
      FROM product_images
      WHERE "productId" = p.id
        AND "isPrimary" = true
      ORDER BY "sortOrder" ASC, "createdAt" ASC
      LIMIT 1
    ) pi ON true
    WHERE c.id = ANY(${rootIds}::text[])
  `;

  // Group rows by categoryId in JS — O(rows) single pass
  const productsByRootId = new Map<string, ICollectionProduct[]>();

  for (const row of rows) {
    if (!productsByRootId.has(row.categoryId)) {
      productsByRootId.set(row.categoryId, []);
    }

    productsByRootId.get(row.categoryId)!.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      shortDesc: row.shortDesc,
      brand: row.brand,
      price: row.price !== null ? row.price : null,
      compareAtPrice: row.compareAtPrice !== null ? row.compareAtPrice : null,
      hasVariants: row.hasVariants,
      isFeatured: row.isFeatured,
      images:
        row.imageId !== null
          ? [
              {
                id: row.imageId,
                src: row.imageSrc!,
                altText: row.imageAlt,
                isPrimary: row.imagePrimary!,
              },
            ]
          : [],
    } as ICollectionProduct);
  }

  roots.forEach((root) => {
    root.products = productsByRootId.get(root.id) ?? [];
  });
};

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * OPTIMIZED: guard checks run in parallel via Promise.all (4 → 1 round).
 */
const createCategory = async (payload: ICreateCategoryPayload) => {
  const parentId = payload.parentId ?? null;
  const imageId = payload.imageId ?? null;

  // All 4 guards fire simultaneously instead of sequentially
  await Promise.all([
    parentId ? ensureParentExists(parentId) : Promise.resolve(),
    imageId ? ensureImageExists(imageId) : Promise.resolve(),
    ensureSlugUnique(payload.slug),
    ensureNameUniqueWithinParent(payload.name, parentId),
  ]);

  const createdCategory = await prisma.$transaction(async (tx) => {
    const category = await tx.category.create({
      data: {
        name: payload.name,
        slug: payload.slug,
        ...(payload.description !== undefined && {
          description: payload.description,
        }),
        ...(imageId && { image: { connect: { id: imageId } } }),
        ...(payload.isActive !== undefined && { isActive: payload.isActive }),
        ...(payload.sortOrder !== undefined && { sortOrder: payload.sortOrder }),
        ...(parentId && { parent: { connect: { id: parentId } } }),
        ...(payload.metaTitle !== undefined && { metaTitle: payload.metaTitle }),
        ...(payload.metaDescription !== undefined && {
          metaDescription: payload.metaDescription,
        }),
        ...(payload.metaKeywords !== undefined && {
          metaKeywords: payload.metaKeywords,
        }),
      },
      select: { id: true },
    });

    const fullCategory = await tx.category.findUnique({
      where: { id: category.id },
      select: categoryDetailsSelect,
    });

    if (!fullCategory) {
      throw new AppError(httpStatus.NOT_FOUND, "Category not found");
    }

    return fullCategory;
  });

  clearPublicCollectionsCache();
  return createdCategory;
};

/**
 * OPTIMIZED: parallel DB queries via Promise.all.
 */
const getCategories = async (query: Record<string, string | undefined>) => {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const skip = (page - 1) * limit;

  const where = buildWhere(query);
  const orderBy = buildOrderBy(query.sort);

  // findMany + count always ran in parallel — preserved
  const [data, total] = await Promise.all([
    prisma.category.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: categoryListSelect,
    }),
    prisma.category.count({ where }),
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

/**
 * OPTIMIZED:
 *   1. sortCollectionTree (O(n log n)) removed — DB ORDER BY handles it.
 *   2. assignProductsToRoots uses a single LATERAL join instead of r queries.
 *   3. Tree build is O(n) with a single Map pass (unchanged, already optimal).
 */
const getPublicCollections = async (
  query: Record<string, string | undefined>,
) => {
  // ── Cache hit path: O(1) ──────────────────────────────────────────────────
  const cacheKey = buildPublicCollectionsCacheKey(query);
  const cached = publicCollectionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
  const productLimit = parseProductLimit(query.productLimit);
  const skip = (page - 1) * limit;

  const { productLimit: _productLimit, ...queryForBuilder } = query;
  const normalizedQuery = { ...queryForBuilder };
  const collectionSearchTerm = normalizedQuery.searchTerm?.trim();
  const collectionName = normalizedQuery.name?.trim();

  if (collectionName && !collectionSearchTerm) {
    normalizedQuery.searchTerm = collectionName;
  }
  delete normalizedQuery.name;

  const qb = new QueryBuilder<
    Prisma.CategoryWhereInput,
    Prisma.CategorySelect,
    Prisma.CategoryOrderByWithRelationInput[]
  >({
    ...normalizedQuery,
    sort: normalizedQuery.sort ?? "sortOrder,name",
  })
    .filter()
    .search(categorySearchableFields)
    .sort();

  const builtQuery = qb.build() as Prisma.CategoryFindManyArgs;
  const where: Prisma.CategoryWhereInput = {
    ...(builtQuery.where ?? {}),
    isActive: true,
  };

  if (query.parentId !== undefined) {
    const parentId = query.parentId.trim().toLowerCase();
    where.parentId =
      parentId === "" || parentId === "null" || parentId === "root"
        ? null
        : query.parentId;
  }

  // ── Single DB query for all matching categories ───────────────────────────
  // ORDER BY is applied here so we never need to re-sort in JS.
  const categories = await prisma.category.findMany({
    where,
    orderBy: (builtQuery.orderBy as Prisma.CategoryOrderByWithRelationInput[]) ?? [
      { sortOrder: "asc" },
      { name: "asc" },
    ],
    select: collectionCategorySelect,
  });

  // ── O(n) tree build — single Map pass ────────────────────────────────────
  // Because the DB already returned rows in (sortOrder, name) order,
  // children are appended in the correct sequence — no JS sort needed.
  const nodeMap = new Map<string, ICategoryCollectionNode>();

  for (const category of categories) {
    nodeMap.set(category.id, {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      imageId: category.imageId,
      image: category.image,
      isActive: category.isActive,
      sortOrder: category.sortOrder,
      parentId: category.parentId,
      products: [],
      children: [],
    });
  }

  const roots: ICategoryCollectionNode[] = [];

  for (const node of nodeMap.values()) {
    if (!node.parentId) {
      roots.push(node);
      continue;
    }
    const parentNode = nodeMap.get(node.parentId);
    // Orphaned nodes (parent filtered out) surface as roots
    (parentNode ?? { children: roots }).children.push(node);
  }

  // ── Paginate roots, then fetch products in one LATERAL query ─────────────
  const total = roots.length;
  const pageRoots = roots.slice(skip, skip + limit);
  await assignProductsToRoots(pageRoots, productLimit);

  const result: PublicCollectionsResponse = {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    data: pageRoots,
  };

  publicCollectionsCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + PUBLIC_COLLECTIONS_CACHE_TTL_MS,
  });

  return result;
};

const getCategoryById = async (categoryId: string) => {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: categoryDetailsSelect,
  });

  if (!category) {
    throw new AppError(httpStatus.NOT_FOUND, "Category not found");
  }

  return category;
};

const updateCategory = async (
  categoryId: string,
  payload: IUpdateCategoryPayload,
) => {
  const existingCategory = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true, name: true, slug: true, parentId: true, imageId: true },
  });

  if (!existingCategory) {
    throw new AppError(httpStatus.NOT_FOUND, "Category not found");
  }

  if (Object.keys(payload).length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "At least one field is required to update category",
    );
  }

  if (payload.parentId !== undefined && payload.parentId === categoryId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A category cannot be its own parent",
    );
  }

  if (payload.parentId !== undefined && payload.parentId !== null) {
    // ensureParentExists + ensureNoCircularParent (CTE) run in parallel
    await Promise.all([
      ensureParentExists(payload.parentId),
      ensureNoCircularParent(categoryId, payload.parentId),
    ]);
  }

  if (payload.imageId !== undefined && payload.imageId !== null) {
    await ensureImageExists(payload.imageId);
  }

  const nextParentId =
    payload.parentId !== undefined ? payload.parentId : existingCategory.parentId;
  const nextName = payload.name ?? existingCategory.name;

  // Slug + name uniqueness can also run in parallel when both are needed
  const uniquenessChecks: Promise<void>[] = [];

  if (payload.slug !== undefined && payload.slug !== existingCategory.slug) {
    uniquenessChecks.push(ensureSlugUnique(payload.slug, categoryId));
  }

  if (payload.name !== undefined || payload.parentId !== undefined) {
    uniquenessChecks.push(
      ensureNameUniqueWithinParent(nextName, nextParentId ?? null, categoryId),
    );
  }

  if (uniquenessChecks.length > 0) {
    await Promise.all(uniquenessChecks);
  }

  const updateData: Prisma.CategoryUpdateInput = {
    ...(payload.name !== undefined && { name: payload.name }),
    ...(payload.slug !== undefined && { slug: payload.slug }),
    ...(payload.description !== undefined && { description: payload.description }),
    ...(payload.isActive !== undefined && { isActive: payload.isActive }),
    ...(payload.sortOrder !== undefined && { sortOrder: payload.sortOrder }),
    ...(payload.metaTitle !== undefined && { metaTitle: payload.metaTitle }),
    ...(payload.metaDescription !== undefined && {
      metaDescription: payload.metaDescription,
    }),
    ...(payload.metaKeywords !== undefined && {
      metaKeywords: payload.metaKeywords,
    }),
  };

  if (payload.parentId !== undefined) {
    updateData.parent = payload.parentId
      ? { connect: { id: payload.parentId } }
      : { disconnect: true };
  }

  if (payload.imageId !== undefined) {
    updateData.image = payload.imageId
      ? { connect: { id: payload.imageId } }
      : { disconnect: true };
  }

  const updatedCategory = await prisma.$transaction(async (tx) => {
    if (Object.keys(updateData).length > 0) {
      await tx.category.update({
        where: { id: categoryId },
        data: updateData,
      });
    }

    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: categoryDetailsSelect,
    });

    if (!category) {
      throw new AppError(httpStatus.NOT_FOUND, "Category not found");
    }

    return category;
  });

  clearPublicCollectionsCache();
  return updatedCategory;
};

const deleteCategory = async (categoryId: string) => {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });

  if (!category) {
    throw new AppError(httpStatus.NOT_FOUND, "Category not found");
  }

  await prisma.$transaction(async (tx) => {
    const categoryIdsToDelete = await collectCategorySubtreeIds(categoryId, tx);

    await tx.product.updateMany({
      where: { categoryId: { in: categoryIdsToDelete } },
      data: { categoryId: null },
    });

    await tx.category.deleteMany({
      where: { id: { in: categoryIdsToDelete } },
    });
  });

  clearPublicCollectionsCache();
};

// ─── Exports ──────────────────────────────────────────────────────────────────

export const CategoryService = {
  createCategory,
  getCategories,
  getPublicCollections,
  getCategoryById,
  updateCategory,
  deleteCategory,
};

// import httpStatus from "http-status-codes";
// import type { Prisma } from "../../../../generated/prisma/client";
// import AppError from "../../helper/AppError";
// import { prisma } from "../../lib/prisma";
// import { QueryBuilder } from "../../utils/QueryBuilder";
// import { categorySearchableFields } from "./category.constant";
// import type {
//   ICollectionProduct,
//   ICategoryCollectionNode,
//   ICreateCategoryPayload,
//   IUpdateCategoryPayload,
// } from "./category.interface";

// type PublicCollectionsResponse = {
//   meta: {
//     page: number;
//     limit: number;
//     total: number;
//     totalPage: number;
//   };
//   data: ICategoryCollectionNode[];
// };

// const PUBLIC_COLLECTIONS_CACHE_TTL_MS = 60_000;
// const publicCollectionsCache = new Map<
//   string,
//   { expiresAt: number; value: PublicCollectionsResponse }
// >();

// const categoryImageSelect = {
//   id: true,
//   src: true,
//   publicId: true,
//   altText: true,
//   sortOrder: true,
//   isPrimary: true,
//   createdAt: true,
//   updatedAt: true,
// } satisfies Prisma.ProductImageSelect;

// const categoryBaseSelect = {
//   id: true,
//   name: true,
//   slug: true,
//   description: true,
//   imageId: true,
//   image: {
//     select: categoryImageSelect,
//   },
//   isActive: true,
//   sortOrder: true,
//   parentId: true,
//   metaTitle: true,
//   metaDescription: true,
//   metaKeywords: true,
//   createdAt: true,
//   updatedAt: true,
// } satisfies Prisma.CategorySelect;

// const categoryListSelect = {
//   ...categoryBaseSelect,
//   parent: {
//     select: {
//       id: true,
//       name: true,
//       slug: true,
//     },
//   },
//   _count: {
//     select: {
//       children: true,
//       products: true,
//     },
//   },
// } satisfies Prisma.CategorySelect;

// const categoryDetailsSelect = {
//   ...categoryListSelect,
//   children: {
//     select: {
//       id: true,
//       name: true,
//       slug: true,
//       isActive: true,
//       sortOrder: true,
//       parentId: true,
//     },
//     orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
//   },
// } satisfies Prisma.CategorySelect;

// const collectionCategorySelect = {
//   id: true,
//   name: true,
//   slug: true,
//   description: true,
//   imageId: true,
//   image: {
//     select: categoryImageSelect,
//   },
//   isActive: true,
//   sortOrder: true,
//   parentId: true,
// } satisfies Prisma.CategorySelect;

// const collectionProductSelect = {
//   id: true,
//   title: true,
//   slug: true,
//   shortDesc: true,
//   brand: true,
//   price: true,
//   compareAtPrice: true,
//   hasVariants: true,
//   isFeatured: true,
//   images: {
//     where: {
//       isPrimary: true,
//     },
//     orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
//     take: 1,
//     select: {
//       id: true,
//       src: true,
//       altText: true,
//       isPrimary: true,
//     },
//   },
// } satisfies Prisma.ProductSelect;

// const parseProductLimit = (value: string | undefined) => {
//   const parsed = Number(value);

//   if (!Number.isFinite(parsed)) {
//     return 8;
//   }

//   return Math.min(Math.max(Math.floor(parsed), 1), 24);
// };

// const assignProductsToRoots = async (
//   roots: ICategoryCollectionNode[],
//   productLimit: number,
// ) => {
//   if (!roots.length || productLimit <= 0) {
//     return;
//   }

//   const rootIds = roots.map((root) => root.id);
//   const rootProductRows = await prisma.category.findMany({
//     where: {
//       id: {
//         in: rootIds,
//       },
//     },
//     select: {
//       id: true,
//       products: {
//         where: {
//           isActive: true,
//         },
//         orderBy: [{ isFeatured: "desc" }, { createdAt: "desc" }],
//         take: productLimit,
//         select: collectionProductSelect,
//       },
//     },
//   });

//   const productsByRootId = new Map<string, ICollectionProduct[]>(
//     rootProductRows.map((row) => [row.id, row.products as ICollectionProduct[]]),
//   );

//   roots.forEach((root) => {
//     root.products = productsByRootId.get(root.id) ?? [];
//   });
// };

// const buildPublicCollectionsCacheKey = (
//   query: Record<string, string | undefined>,
// ) =>
//   Object.entries(query)
//     .filter((entry): entry is [string, string] => entry[1] !== undefined)
//     .sort(([a], [b]) => a.localeCompare(b))
//     .map(([key, value]) => `${key}=${value}`)
//     .join("&");

// const clearPublicCollectionsCache = () => {
//   publicCollectionsCache.clear();
// };

// const ensureParentExists = async (parentId: string) => {
//   const parent = await prisma.category.findUnique({
//     where: { id: parentId },
//     select: { id: true },
//   });

//   if (!parent) {
//     throw new AppError(httpStatus.NOT_FOUND, "Parent category not found");
//   }
// };

// const ensureImageExists = async (imageId: string) => {
//   const image = await prisma.productImage.findUnique({
//     where: { id: imageId },
//     select: { id: true },
//   });

//   if (!image) {
//     throw new AppError(httpStatus.NOT_FOUND, "Image not found");
//   }
// };

// const ensureSlugUnique = async (slug: string, excludedCategoryId?: string) => {
//   const existing = await prisma.category.findFirst({
//     where: {
//       slug,
//       ...(excludedCategoryId && { id: { not: excludedCategoryId } }),
//     },
//     select: { id: true },
//   });

//   if (existing) {
//     throw new AppError(httpStatus.CONFLICT, "Category slug already exists");
//   }
// };

// const ensureNameUniqueWithinParent = async (
//   name: string,
//   parentId: string | null,
//   excludedCategoryId?: string,
// ) => {
//   const existing = await prisma.category.findFirst({
//     where: {
//       name,
//       parentId,
//       ...(excludedCategoryId && { id: { not: excludedCategoryId } }),
//     },
//     select: { id: true },
//   });

//   if (existing) {
//     throw new AppError(
//       httpStatus.CONFLICT,
//       "Category name already exists under this parent",
//     );
//   }
// };

// const ensureNoCircularParent = async (
//   categoryId: string,
//   nextParentId: string,
// ) => {
//   let currentParentId: string | null = nextParentId;

//   while (currentParentId) {
//     if (currentParentId === categoryId) {
//       throw new AppError(
//         httpStatus.BAD_REQUEST,
//         "Circular parent relationship is not allowed",
//       );
//     }

//     const parentCategory: { parentId: string | null } | null =
//       await prisma.category.findUnique({
//         where: { id: currentParentId },
//         select: { parentId: true },
//       });

//     currentParentId = parentCategory?.parentId ?? null;
//   }
// };

// const collectCategorySubtreeIds = async (
//   rootCategoryId: string,
//   tx: Prisma.TransactionClient,
// ) => {
//   const categoryIds = new Set<string>([rootCategoryId]);
//   let currentParentIds = [rootCategoryId];

//   while (currentParentIds.length > 0) {
//     const children = await tx.category.findMany({
//       where: {
//         parentId: {
//           in: currentParentIds,
//         },
//       },
//       select: {
//         id: true,
//       },
//     });

//     const nextParentIds: string[] = [];

//     for (const child of children) {
//       if (categoryIds.has(child.id)) {
//         continue;
//       }

//       categoryIds.add(child.id);
//       nextParentIds.push(child.id);
//     }

//     currentParentIds = nextParentIds;
//   }

//   return Array.from(categoryIds);
// };

// const buildOrderBy = (
//   sort: string | undefined,
// ): Prisma.CategoryOrderByWithRelationInput[] => {
//   if (!sort) {
//     return [{ sortOrder: "asc" }, { createdAt: "desc" }];
//   }

//   return sort
//     .split(",")
//     .map((field) => field.trim())
//     .filter(Boolean)
//     .map((field) => {
//       if (field.startsWith("-")) {
//         return { [field.slice(1)]: "desc" };
//       }

//       return { [field]: "asc" };
//     }) as Prisma.CategoryOrderByWithRelationInput[];
// };

// const buildWhere = (query: Record<string, string | undefined>) => {
//   const where: Prisma.CategoryWhereInput = {};
//   const searchTerm = query.searchTerm?.trim();
//   const name = query.name?.trim();

//   if (searchTerm) {
//     where.OR = categorySearchableFields.map((field) => ({
//       [field]: {
//         contains: searchTerm,
//         mode: "insensitive",
//       },
//     }));
//   }

//   if (name) {
//     where.name = {
//       contains: name,
//       mode: "insensitive",
//     };
//   }

//   if (query.parentId !== undefined) {
//     const parentId = query.parentId.trim().toLowerCase();

//     if (parentId === "" || parentId === "null" || parentId === "root") {
//       where.parentId = null;
//     } else {
//       where.parentId = query.parentId.trim();
//     }
//   }

//   if (query.isActive !== undefined) {
//     if (query.isActive !== "true" && query.isActive !== "false") {
//       throw new AppError(
//         httpStatus.BAD_REQUEST,
//         "isActive query must be true or false",
//       );
//     }

//     where.isActive = query.isActive === "true";
//   }

//   return where;
// };

// const createCategory = async (payload: ICreateCategoryPayload) => {
//   const parentId = payload.parentId ?? null;
//   const imageId = payload.imageId ?? null;

//   if (parentId) {
//     await ensureParentExists(parentId);
//   }

//   if (imageId) {
//     await ensureImageExists(imageId);
//   }

//   await Promise.all([
//     ensureSlugUnique(payload.slug),
//     ensureNameUniqueWithinParent(payload.name, parentId),
//   ]);

//   const createdCategory = await prisma.$transaction(async (tx) => {
//     const category = await tx.category.create({
//       data: {
//         name: payload.name,
//         slug: payload.slug,
//         ...(payload.description !== undefined && {
//           description: payload.description,
//         }),
//         ...(imageId && { image: { connect: { id: imageId } } }),
//         ...(payload.isActive !== undefined && { isActive: payload.isActive }),
//         ...(payload.sortOrder !== undefined && { sortOrder: payload.sortOrder }),
//         ...(parentId && { parent: { connect: { id: parentId } } }),
//         ...(payload.metaTitle !== undefined && { metaTitle: payload.metaTitle }),
//         ...(payload.metaDescription !== undefined && {
//           metaDescription: payload.metaDescription,
//         }),
//         ...(payload.metaKeywords !== undefined && {
//           metaKeywords: payload.metaKeywords,
//         }),
//       },
//       select: {
//         id: true,
//       },
//     });

//     const fullCategory = await tx.category.findUnique({
//       where: { id: category.id },
//       select: categoryDetailsSelect,
//     });

//     if (!fullCategory) {
//       throw new AppError(httpStatus.NOT_FOUND, "Category not found");
//     }

//     return fullCategory;
//   });

//   clearPublicCollectionsCache();

//   return createdCategory;
// };

// const getCategories = async (query: Record<string, string | undefined>) => {
//   const page = Math.max(Number(query.page) || 1, 1);
//   const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
//   const skip = (page - 1) * limit;

//   const where = buildWhere(query);
//   const orderBy = buildOrderBy(query.sort);

//   const [data, total] = await Promise.all([
//     prisma.category.findMany({
//       where,
//       orderBy,
//       skip,
//       take: limit,
//       select: categoryListSelect,
//     }),
//     prisma.category.count({ where }),
//   ]);

//   return {
//     meta: {
//       page,
//       limit,
//       total,
//       totalPage: Math.ceil(total / limit),
//     },
//     data,
//   };
// };

// const sortCollectionTree = (nodes: ICategoryCollectionNode[]) => {
//   nodes.sort((a, b) => {
//     if (a.sortOrder !== b.sortOrder) {
//       return a.sortOrder - b.sortOrder;
//     }

//     return a.name.localeCompare(b.name);
//   });

//   nodes.forEach((node) => sortCollectionTree(node.children));
// };

// const getPublicCollections = async (query: Record<string, string | undefined>) => {
//   const cacheKey = buildPublicCollectionsCacheKey(query);
//   const cached = publicCollectionsCache.get(cacheKey);

//   if (cached && cached.expiresAt > Date.now()) {
//     return cached.value;
//   }

//   const page = Math.max(Number(query.page) || 1, 1);
//   const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
//   const productLimit = parseProductLimit(query.productLimit);
//   const skip = (page - 1) * limit;
//   const { productLimit: _productLimit, ...queryForBuilder } = query;
//   const normalizedQueryForBuilder = { ...queryForBuilder };
//   const collectionSearchTerm = normalizedQueryForBuilder.searchTerm?.trim();
//   const collectionName = normalizedQueryForBuilder.name?.trim();

//   if (collectionName && !collectionSearchTerm) {
//     normalizedQueryForBuilder.searchTerm = collectionName;
//   }

//   if (normalizedQueryForBuilder.name !== undefined) {
//     delete normalizedQueryForBuilder.name;
//   }

//   const qb = new QueryBuilder<
//     Prisma.CategoryWhereInput,
//     Prisma.CategorySelect,
//     Prisma.CategoryOrderByWithRelationInput[]
//   >({
//     ...normalizedQueryForBuilder,
//     sort: normalizedQueryForBuilder.sort ?? "sortOrder,name",
//   })
//     .filter()
//     .search(categorySearchableFields)
//     .sort();

//   const builtQuery = qb.build() as Prisma.CategoryFindManyArgs;
//   const where: Prisma.CategoryWhereInput = {
//     ...(builtQuery.where ?? {}),
//     isActive: true,
//   };

//   if (query.parentId !== undefined) {
//     const parentId = query.parentId.trim().toLowerCase();

//     where.parentId =
//       parentId === "" || parentId === "null" || parentId === "root"
//         ? null
//         : query.parentId;
//   }

//   const categories = await prisma.category.findMany({
//     where,
//     orderBy:
//       (builtQuery.orderBy as Prisma.CategoryOrderByWithRelationInput[]) ?? [
//         { sortOrder: "asc" },
//         { name: "asc" },
//       ],
//     select: collectionCategorySelect,
//   });

//   const nodeMap = new Map<string, ICategoryCollectionNode>();

//   categories.forEach((category) => {
//     nodeMap.set(category.id, {
//       id: category.id,
//       name: category.name,
//       slug: category.slug,
//       description: category.description,
//       imageId: category.imageId,
//       image: category.image,
//       isActive: category.isActive,
//       sortOrder: category.sortOrder,
//       parentId: category.parentId,
//       products: [],
//       children: [],
//     });
//   });

//   const roots: ICategoryCollectionNode[] = [];

//   nodeMap.forEach((node) => {
//     if (!node.parentId) {
//       roots.push(node);
//       return;
//     }

//     const parentNode = nodeMap.get(node.parentId);

//     if (!parentNode) {
//       roots.push(node);
//       return;
//     }

//     parentNode.children.push(node);
//   });

//   sortCollectionTree(roots);

//   const total = roots.length;
//   const data = roots.slice(skip, skip + limit);
//   await assignProductsToRoots(data, productLimit);

//   const result: PublicCollectionsResponse = {
//     meta: {
//       page,
//       limit,
//       total,
//       totalPage: Math.ceil(total / limit),
//     },
//     data,
//   };

//   publicCollectionsCache.set(cacheKey, {
//     value: result,
//     expiresAt: Date.now() + PUBLIC_COLLECTIONS_CACHE_TTL_MS,
//   });

//   return result;
// };

// const getCategoryById = async (categoryId: string) => {
//   const category = await prisma.category.findUnique({
//     where: { id: categoryId },
//     select: categoryDetailsSelect,
//   });

//   if (!category) {
//     throw new AppError(httpStatus.NOT_FOUND, "Category not found");
//   }

//   return category;
// };

// const updateCategory = async (
//   categoryId: string,
//   payload: IUpdateCategoryPayload,
// ) => {
//   const existingCategory = await prisma.category.findUnique({
//     where: { id: categoryId },
//     select: {
//       id: true,
//       name: true,
//       slug: true,
//       parentId: true,
//       imageId: true,
//     },
//   });

//   if (!existingCategory) {
//     throw new AppError(httpStatus.NOT_FOUND, "Category not found");
//   }

//   if (Object.keys(payload).length === 0) {
//     throw new AppError(
//       httpStatus.BAD_REQUEST,
//       "At least one field is required to update category",
//     );
//   }

//   if (payload.parentId !== undefined && payload.parentId === categoryId) {
//     throw new AppError(
//       httpStatus.BAD_REQUEST,
//       "A category cannot be its own parent",
//     );
//   }

//   if (payload.parentId !== undefined && payload.parentId !== null) {
//     await ensureParentExists(payload.parentId);
//     await ensureNoCircularParent(categoryId, payload.parentId);
//   }

//   if (payload.imageId !== undefined && payload.imageId !== null) {
//     await ensureImageExists(payload.imageId);
//   }

//   const nextParentId =
//     payload.parentId !== undefined ? payload.parentId : existingCategory.parentId;
//   const nextName = payload.name ?? existingCategory.name;

//   if (payload.slug !== undefined && payload.slug !== existingCategory.slug) {
//     await ensureSlugUnique(payload.slug, categoryId);
//   }

//   if (payload.name !== undefined || payload.parentId !== undefined) {
//     await ensureNameUniqueWithinParent(nextName, nextParentId ?? null, categoryId);
//   }

//   const updateData: Prisma.CategoryUpdateInput = {
//     ...(payload.name !== undefined && { name: payload.name }),
//     ...(payload.slug !== undefined && { slug: payload.slug }),
//     ...(payload.description !== undefined && { description: payload.description }),
//     ...(payload.isActive !== undefined && { isActive: payload.isActive }),
//     ...(payload.sortOrder !== undefined && { sortOrder: payload.sortOrder }),
//     ...(payload.metaTitle !== undefined && { metaTitle: payload.metaTitle }),
//     ...(payload.metaDescription !== undefined && {
//       metaDescription: payload.metaDescription,
//     }),
//     ...(payload.metaKeywords !== undefined && {
//       metaKeywords: payload.metaKeywords,
//     }),
//   };

//   if (payload.parentId !== undefined) {
//     updateData.parent = payload.parentId
//       ? { connect: { id: payload.parentId } }
//       : { disconnect: true };
//   }

//   if (payload.imageId !== undefined) {
//     updateData.image = payload.imageId
//       ? { connect: { id: payload.imageId } }
//       : { disconnect: true };
//   }

//   const updatedCategory = await prisma.$transaction(async (tx) => {
//     if (Object.keys(updateData).length > 0) {
//       await tx.category.update({
//         where: { id: categoryId },
//         data: updateData,
//       });
//     }

//     const category = await tx.category.findUnique({
//       where: { id: categoryId },
//       select: categoryDetailsSelect,
//     });

//     if (!category) {
//       throw new AppError(httpStatus.NOT_FOUND, "Category not found");
//     }

//     return category;
//   });

//   clearPublicCollectionsCache();

//   return updatedCategory;
// };

// const deleteCategory = async (categoryId: string) => {
//   const category = await prisma.category.findUnique({
//     where: { id: categoryId },
//     select: { id: true },
//   });

//   if (!category) {
//     throw new AppError(httpStatus.NOT_FOUND, "Category not found");
//   }

//   await prisma.$transaction(async (tx) => {
//     const categoryIdsToDelete = await collectCategorySubtreeIds(categoryId, tx);

//     await tx.product.updateMany({
//       where: {
//         categoryId: {
//           in: categoryIdsToDelete,
//         },
//       },
//       data: {
//         categoryId: null,
//       },
//     });

//     await tx.category.deleteMany({
//       where: {
//         id: {
//           in: categoryIdsToDelete,
//         },
//       },
//     });
//   });

//   clearPublicCollectionsCache();
// };

// export const CategoryService = {
//   createCategory,
//   getCategories,
//   getPublicCollections,
//   getCategoryById,
//   updateCategory,
//   deleteCategory,
// };
