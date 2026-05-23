import type { NextFunction, Request, Response } from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import httpStatus from "http-status-codes";
import AppError from "../helper/AppError";
import {
  uploadForSupabase,
  uploadProductImage,
  uploadWithCloudinary,
} from "../lib/multer";
import { getSupabaseBucket, getSupabaseClient } from "../lib/supabase";

type StorageType = "link" | "local" | "cloudinary" | "supabase";

const storageTypes: StorageType[] = ["link", "local", "cloudinary", "supabase"];

const storageTypeAliases: Record<string, StorageType> = {
  cloudnery: "cloudinary",
  cloudenery: "cloudinary",
  cloudeniary: "cloudinary",
  cloudinery: "cloudinary",
  subabase: "supabase",
  subaabase: "supabase",
};

const getStorageType = (req: Request): StorageType => {
  const storageType = (req.query.storageType as string | undefined)
    ?.trim()
    .toLowerCase();

  const normalizedStorageType = storageType
    ? (storageTypeAliases[storageType] ?? storageType)
    : undefined;

  if (
    !normalizedStorageType ||
    !storageTypes.includes(normalizedStorageType as StorageType)
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Invalid storageType. Use one of: link, local, cloudinary, supabase",
    );
  }

  return normalizedStorageType as StorageType;
};

const extractFiles = (req: Request): Express.Multer.File[] => {
  if (!req.files) return [];

  if (Array.isArray(req.files)) {
    return req.files;
  }

  const filesByField = req.files as Record<string, Express.Multer.File[]>;
  return Object.values(filesByField).flat();
};

const uploadWithMulter = (
  req: Request,
  res: Response,
  storageType: StorageType,
): Promise<Express.Multer.File[]> => {
  const uploader =
    storageType === "cloudinary"
      ? uploadWithCloudinary
      : storageType === "supabase"
        ? uploadForSupabase
        : uploadProductImage;

  return new Promise((resolve, reject) => {
    uploader.fields([
      { name: "files", maxCount: 20 },
      { name: "images", maxCount: 20 },
      { name: "videos", maxCount: 20 },
    ])(req, res, (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(extractFiles(req));
    });
  });
};

const buildMediaType = (mimeType: string) => {
  if (mimeType.startsWith("video/")) {
    return "video";
  }

  return "image";
};

const ensureLinkPayload = (req: Request) => {
  const mediaUrlsRaw = req.body.mediaUrls;
  const mediaUrlRaw = req.body.mediaUrl;

  let mediaUrls: unknown[] = [];

  if (Array.isArray(mediaUrlsRaw)) {
    mediaUrls = mediaUrlsRaw;
  } else if (typeof mediaUrlsRaw === "string" && mediaUrlsRaw.trim()) {
    const trimmed = mediaUrlsRaw.trim();

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);

        if (Array.isArray(parsed)) {
          mediaUrls = parsed;
        }
      } catch {
        mediaUrls = [trimmed];
      }
    } else {
      mediaUrls = [trimmed];
    }
  } else if (mediaUrlRaw) {
    mediaUrls = [mediaUrlRaw];
  }

  if (!mediaUrls.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "For storageType=link, provide mediaUrl or mediaUrls[]",
    );
  }

  mediaUrls.forEach((url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Each mediaUrl must be a valid http/https URL",
      );
    }
  });

  return mediaUrls as string[];
};

const getFileNameFromUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments.at(-1);

    if (!lastSegment) {
      return undefined;
    }

    return decodeURIComponent(lastSegment);
  } catch {
    return undefined;
  }
};

export const uploadImages = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const storageType = getStorageType(req);
    req.uploadedImages = [];

    if (storageType === "link") {
      const mediaUrls = ensureLinkPayload(req);

      mediaUrls.forEach((url) => {
        const fileName = getFileNameFromUrl(url);

        req.uploadedImages!.push({
          storageType: "link",
          src: url,
          publicId: `link:${uuidv4()}`,
          ...(fileName !== undefined && { fileName }),
        });
      });

      next();
      return;
    }

    const files = await uploadWithMulter(req, res, storageType);

    if (!files.length) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "No files received. Send files in 'files', 'images', or 'videos' field",
      );
    }

    if (storageType === "local") {
      files.forEach((file) => {
        req.uploadedImages!.push({
          storageType: "local",
          src: `/api/uploads/media/${file.filename}`,
          publicId: `local:${file.filename}`,
          fileName: file.originalname,
        });
      });

      next();
      return;
    }

    if (storageType === "cloudinary") {
      files.forEach((file) => {
        const cloudinaryFile = file as Express.Multer.File & {
          secure_url?: string;
          url?: string;
        };
        const mediaSrc =
          cloudinaryFile.path || cloudinaryFile.secure_url || cloudinaryFile.url;

        if (!mediaSrc) {
          throw new AppError(
            httpStatus.BAD_REQUEST,
            "Cloudinary upload failed to return a media URL",
          );
        }

        req.uploadedImages!.push({
          storageType: "cloudinary",
          src: mediaSrc,
          publicId: `cloudinary:${file.filename}`,
          fileName: file.originalname,
        });
      });

      next();
      return;
    }

    const supabase = getSupabaseClient();
    const bucket = getSupabaseBucket();

    for (const file of files) {
      const ext = path.extname(file.originalname) || "";
      const mediaType = buildMediaType(file.mimetype);
      const objectPath = `${mediaType}s/${Date.now()}-${uuidv4()}${ext}`;

      const { error } = await supabase.storage
        .from(bucket)
        .upload(objectPath, file.buffer, {
          upsert: false,
          contentType: file.mimetype,
        });

      if (error) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          `Supabase upload failed: ${error.message}`,
        );
      }

      const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);

      req.uploadedImages!.push({
        storageType: "supabase",
        src: data.publicUrl,
        publicId: `supabase:${objectPath}`,
        fileName: file.originalname,
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};
