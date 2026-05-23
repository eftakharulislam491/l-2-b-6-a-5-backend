export interface IAddCartItemPayload {
  productId: string;
  optionIds?: string[];
  variantOptionId?: string;
  variantOptionIds?: string[];
  quantity?: number;
}

export interface IUpdateCartItemPayload {
  quantity: number;
}
