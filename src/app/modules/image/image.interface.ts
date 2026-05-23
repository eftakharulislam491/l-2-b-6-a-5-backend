export type MediaStorageType = "link" | "local" | "cloudinary" | "supabase";

export type MediaType = "image" | "video";

export interface IProductImage {
  id: string;
  productId?: string | null;
  variantId?: string | null;
  variantOptionId?: string | null;
  src: string;
  publicId?: string | null;
  fileName?: string | null;
  altText?: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUploadedMedia {
  storageType: MediaStorageType;
  src: string;
  publicId?: string;
  fileName?: string;
}

export interface ICreateMediaRequestBody {
  productId?: string;
  variantId?: string;
  variantOptionId?: string;
  altText?: string;
  isPrimary?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
}

export interface ICreateMediaPayload {
  productId?: string;
  variantId?: string;
  variantOptionId?: string;
  images: {
    src: string;
    publicId?: string;
    fileName?: string;
    altText?: string;
    isPrimary?: boolean;
  }[];
}
