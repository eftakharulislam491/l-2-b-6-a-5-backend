import httpStatus from "http-status-codes";
import type { Prisma } from "../../../../generated/prisma/client";
import AppError from "../../helper/AppError";
import { prisma } from "../../lib/prisma";
import { cleanupImages } from "../../utils/cleanupImage";
import type {
  ICreateMediaPayload,
  MediaStorageType,
  MediaType,
} from "./image.interface";

const mediaSelect = {
  id: true,
  src: true,
  publicId: true,
  fileName: true,
  altText: true,
  isPrimary: true,
  productId: true,
  variantId: true,
  variantOptionId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductImageSelect;

const mediaSearchableFields = ["altText", "src", "publicId", "fileName"] as const;
const mediaSortableFields = [
  "createdAt",
  "updatedAt",
  "sortOrder",
  "src",
  "publicId",
  "fileName",
  "altText",
  "isPrimary",
  "productId",
  "variantId",
  "variantOptionId",
] as const;
const mediaSelectableFields = [
  "id",
  "src",
  "publicId",
  "sortOrder",
  "fileName",
  "altText",
  "isPrimary",
  "productId",
  "variantId",
  "variantOptionId",
  "createdAt",
  "updatedAt",
] as const;

const mediaSortableFieldSet = new Set<string>(mediaSortableFields);
const mediaSelectableFieldSet = new Set<string>(mediaSelectableFields);
const mediaTypeSet = new Set<MediaType>(["image", "video"]);
const storageTypeSet = new Set<MediaStorageType>([
  "link",
  "local",
  "cloudinary",
  "supabase",
]);

const videoExtensions = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mkv",
  ".m4v",
]);

const getMediaType = (src: string) => {
  const normalized = src.split("?")[0]?.split("#")[0] ?? src;

  for (const ext of videoExtensions) {
    if (normalized.toLowerCase().endsWith(ext)) {
      return "video" as const;
    }
  }

  return "image" as const;
};

const parseBooleanQuery = (value: string, key: string) => {
  if (value !== "true" && value !== "false") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `${key} query must be true or false`,
    );
  }

  return value === "true";
};

const parseIntegerQuery = (value: string, key: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new AppError(httpStatus.BAD_REQUEST, `${key} query must be an integer`);
  }

  return parsed;
};

const parseNullableRelationQuery = (value: string | undefined) => {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue || trimmedValue.toLowerCase() === "null") {
    return null;
  }

  return trimmedValue;
};

const parseMediaTypeQuery = (value: string | undefined): MediaType | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase() as MediaType;

  if (!mediaTypeSet.has(normalizedValue)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "mediaType query must be 'image' or 'video'",
    );
  }

  return normalizedValue;
};

const parseStorageTypeQuery = (
  value: string | undefined,
): MediaStorageType | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase() as MediaStorageType;

  if (!storageTypeSet.has(normalizedValue)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "storageType query must be one of: link, local, cloudinary, supabase",
    );
  }

  return normalizedValue;
};

const buildVideoSourceFilter = (): Prisma.ProductImageWhereInput => ({
  OR: Array.from(videoExtensions).flatMap((extension) => [
    {
      src: {
        endsWith: extension,
        mode: "insensitive",
      },
    },
    {
      src: {
        contains: `${extension}?`,
        mode: "insensitive",
      },
    },
    {
      src: {
        contains: `${extension}#`,
        mode: "insensitive",
      },
    },
  ]),
});

const buildStorageTypeFilter = (
  storageType: MediaStorageType,
): Prisma.ProductImageWhereInput => {
  if (storageType === "local") {
    return {
      OR: [
        { publicId: { startsWith: "local:" } },
        { src: { startsWith: "/api/uploads/" } },
      ],
    };
  }

  if (storageType === "cloudinary") {
    return {
      OR: [
        { publicId: { startsWith: "cloudinary:" } },
        { src: { contains: "res.cloudinary.com", mode: "insensitive" } },
      ],
    };
  }

  if (storageType === "supabase") {
    return {
      OR: [
        { publicId: { startsWith: "supabase:" } },
        {
          src: {
            contains: "supabase.co/storage/v1/object/public",
            mode: "insensitive",
          },
        },
      ],
    };
  }

  return {
    OR: [{ publicId: { startsWith: "link:" } }],
  };
};

const buildWhere = (
  query: Record<string, string | undefined>,
): Prisma.ProductImageWhereInput => {
  const andConditions: Prisma.ProductImageWhereInput[] = [];
  const searchTerm = query.searchTerm?.trim();
  const id = query.id?.trim();
  const src = query.src?.trim();
  const publicId = query.publicId?.trim();
  const fileName = query.fileName?.trim();
  const altText = query.altText?.trim();

  if (id) {
    andConditions.push({ id });
  }

  if (searchTerm) {
    andConditions.push({
      OR: mediaSearchableFields.map((field) => ({
        [field]: {
          contains: searchTerm,
          mode: "insensitive",
        },
      })),
    });
  }

  if (src) {
    andConditions.push({
      src: {
        contains: src,
        mode: "insensitive",
      },
    });
  }

  if (publicId) {
    andConditions.push({
      publicId: {
        contains: publicId,
        mode: "insensitive",
      },
    });
  }

  if (fileName) {
    andConditions.push({
      fileName: {
        contains: fileName,
        mode: "insensitive",
      },
    });
  }

  if (altText) {
    andConditions.push({
      altText: {
        contains: altText,
        mode: "insensitive",
      },
    });
  }

  const productId = parseNullableRelationQuery(query.productId);
  const variantId = parseNullableRelationQuery(query.variantId);
  const variantOptionId = parseNullableRelationQuery(query.variantOptionId);

  if (productId !== undefined) {
    andConditions.push({ productId });
  }

  if (variantId !== undefined) {
    andConditions.push({ variantId });
  }

  if (variantOptionId !== undefined) {
    andConditions.push({ variantOptionId });
  }

  if (query.isPrimary !== undefined) {
    andConditions.push({
      isPrimary: parseBooleanQuery(query.isPrimary, "isPrimary"),
    });
  }

  if (query.sortOrder !== undefined) {
    andConditions.push({
      sortOrder: parseIntegerQuery(query.sortOrder, "sortOrder"),
    });
  }

  const mediaType = parseMediaTypeQuery(query.mediaType);
  const videoSourceFilter = buildVideoSourceFilter();

  if (mediaType === "video") {
    andConditions.push(videoSourceFilter);
  } else if (mediaType === "image") {
    andConditions.push({
      NOT: videoSourceFilter,
    });
  }

  const storageType = parseStorageTypeQuery(query.storageType);

  if (storageType) {
    andConditions.push(buildStorageTypeFilter(storageType));
  }

  if (!andConditions.length) {
    return {};
  }

  return {
    AND: andConditions,
  };
};

const buildOrderBy = (
  sort: string | undefined,
): Prisma.ProductImageOrderByWithRelationInput[] => {
  if (!sort) {
    return [{ createdAt: "desc" }];
  }

  const orderBy = sort
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      const direction = field.startsWith("-") ? "desc" : "asc";
      const normalizedField = field.replace(/^-/, "");

      if (!mediaSortableFieldSet.has(normalizedField)) {
        return null;
      }

      return {
        [normalizedField]: direction,
      } as Prisma.ProductImageOrderByWithRelationInput;
    })
    .filter(
      (value): value is Prisma.ProductImageOrderByWithRelationInput =>
        value !== null,
    );

  if (!orderBy.length) {
    return [{ createdAt: "desc" }];
  }

  return orderBy;
};

const buildSelect = (
  fields: string | undefined,
): Prisma.ProductImageSelect | undefined => {
  if (!fields) {
    return undefined;
  }

  const parsedFields = [...new Set(fields.split(",").map((field) => field.trim()))]
    .filter(Boolean);

  if (!parsedFields.length) {
    return undefined;
  }

  const select: Record<string, true> = {};

  for (const field of parsedFields) {
    if (!mediaSelectableFieldSet.has(field)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Invalid fields query: '${field}' is not selectable`,
      );
    }

    select[field] = true;
  }

  return select as Prisma.ProductImageSelect;
};

const getPagination = (query: Record<string, string | undefined>) => {
  const pageParsed = Number(query.page);
  const limitParsed = Number(query.limit);

  const page =
    Number.isFinite(pageParsed) && pageParsed > 0 ? Math.floor(pageParsed) : 1;
  const limitRaw =
    Number.isFinite(limitParsed) && limitParsed > 0 ? Math.floor(limitParsed) : 10;
  const limit = Math.min(limitRaw, 100);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const resolveStorageType = (image: { src: string; publicId: string | null }) => {
  const publicId = image.publicId ?? "";

  if (publicId.startsWith("link:")) {
    return "link" as MediaStorageType;
  }

  if (publicId.startsWith("local:")) {
    return "local" as MediaStorageType;
  }

  if (publicId.startsWith("cloudinary:")) {
    return "cloudinary" as MediaStorageType;
  }

  if (publicId.startsWith("supabase:")) {
    return "supabase" as MediaStorageType;
  }

  if (image.src.startsWith("/api/uploads/")) {
    return "local" as MediaStorageType;
  }

  if (image.src.includes("res.cloudinary.com")) {
    return "cloudinary" as MediaStorageType;
  }

  if (image.src.includes("supabase.co/storage/v1/object/public")) {
    return "supabase" as MediaStorageType;
  }

  return "link" as MediaStorageType;
};

const ensureRelationsExist = async (payload: ICreateMediaPayload) => {
  const [product, variant, variantOption] = await Promise.all([
    payload.productId
      ? prisma.product.findUnique({
          where: { id: payload.productId },
          select: { id: true },
        })
      : Promise.resolve(null),
    payload.variantId
      ? prisma.productVariant.findUnique({
          where: { id: payload.variantId },
          select: { id: true },
        })
      : Promise.resolve(null),
    payload.variantOptionId
      ? prisma.variantOption.findUnique({
          where: { id: payload.variantOptionId },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (payload.productId && !product) {
    throw new AppError(httpStatus.NOT_FOUND, "Product not found");
  }

  if (payload.variantId && !variant) {
    throw new AppError(httpStatus.NOT_FOUND, "Variant not found");
  }

  if (payload.variantOptionId && !variantOption) {
    throw new AppError(httpStatus.NOT_FOUND, "Variant option not found");
  }
};

const createImages = async (payload: ICreateMediaPayload) => {
  if (!payload.images.length) {
    throw new AppError(httpStatus.BAD_REQUEST, "Media files are required");
  }

  await ensureRelationsExist(payload);

  const createdImages = await prisma.productImage.createManyAndReturn({
    data: payload.images.map((media) => ({
      src: media.src,
      publicId: media.publicId ?? null,
      fileName: media.fileName ?? null,
      altText: media.altText ?? null,
      isPrimary: media.isPrimary ?? false,
      productId: payload.productId ?? null,
      variantId: payload.variantId ?? null,
      variantOptionId: payload.variantOptionId ?? null,
    })),
    select: mediaSelect,
  });

  return createdImages.map((media) => ({
    ...media,
    mediaType: getMediaType(media.src),
  }));
};

const getAllImages = async (query: Record<string, string | undefined>) => {
  const where = buildWhere(query);
  const orderBy = buildOrderBy(query.sort);
  const { page, limit, skip } = getPagination(query);
  const requestedSelect = buildSelect(query.fields);

  const select = requestedSelect
    ? ({ ...requestedSelect, src: true } as Prisma.ProductImageSelect)
    : mediaSelect;

  const [rows, total] = await Promise.all([
    prisma.productImage.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select,
    }),
    prisma.productImage.count({ where }),
  ]);

  const omitSrc = Boolean(requestedSelect && !requestedSelect.src);

  return {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    data: rows.map((media) => {
      const mediaWithType = {
        ...media,
        mediaType: getMediaType((media as { src: string }).src),
      };

      if (!omitSrc) {
        return mediaWithType;
      }

      const { src: _src, ...rest } = mediaWithType;
      return rest;
    }),
  };
};

const deleteImage = async (imageId: string) => {
  const image = await prisma.productImage.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      src: true,
      publicId: true,
    },
  });

  if (!image) {
    throw new AppError(httpStatus.NOT_FOUND, "Media not found");
  }

  await cleanupImages([
    {
      storageType: resolveStorageType(image),
      src: image.src,
      ...(image.publicId !== null && { publicId: image.publicId }),
    },
  ]);

  await prisma.productImage.delete({
    where: { id: image.id },
  });
};

export const ImageService = {
  createImages,
  getAllImages,
  deleteImage,
};
