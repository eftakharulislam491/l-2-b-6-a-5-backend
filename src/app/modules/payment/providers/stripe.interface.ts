export interface IStripeCheckoutLineItemPayload {
  productName: string;
  unitAmount: number;
  quantity: number;
}

export interface IStripeCheckoutSessionPayload {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  transactionId: string;
  email: string;
  lineItems: IStripeCheckoutLineItemPayload[];
}

export interface IStripeConfig {
  secretKey: string;
  successUrl: string;
  cancelUrl: string;
  currency: string;
}

export interface IStripeCheckoutSessionResult {
  rawResponse: unknown;
  sessionId: string;
  checkoutUrl: string;
}

export interface IStripeCheckoutSessionLookupResult {
  rawResponse: unknown;
  sessionId: string;
  status?: string | undefined;
  paymentStatus?: string | undefined;
  paymentIntentId?: string | undefined;
}
