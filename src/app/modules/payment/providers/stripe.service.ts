import httpStatus from "http-status-codes";
import AppError from "../../../helper/AppError";
import type {
  IStripeCheckoutSessionLookupResult,
  IStripeCheckoutSessionPayload,
  IStripeCheckoutSessionResult,
  IStripeConfig,
} from "./stripe.interface";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_TIMEOUT_MS = 12000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getErrorMessage = (payload: unknown) => {
  if (!isRecord(payload)) {
    return null;
  }

  const error = payload.error;

  if (!isRecord(error)) {
    return null;
  }

  return typeof error.message === "string" ? error.message : null;
};

const normalizeStatus = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  return normalized || undefined;
};

const addLineItemsToPayload = (
  formData: URLSearchParams,
  lineItems: IStripeCheckoutSessionPayload["lineItems"],
  currency: string,
) => {
  lineItems.forEach((item, index) => {
    formData.set(
      `line_items[${index}][price_data][currency]`,
      currency.toLowerCase(),
    );
    formData.set(
      `line_items[${index}][price_data][unit_amount]`,
      String(Math.max(1, Math.round(item.unitAmount * 100))),
    );
    formData.set(
      `line_items[${index}][price_data][product_data][name]`,
      item.productName,
    );
    formData.set(
      `line_items[${index}][quantity]`,
      String(Math.max(1, Math.trunc(item.quantity))),
    );
  });
};

const buildSuccessUrl = (config: IStripeConfig, orderId: string) => {
  const successUrl = new URL(config.successUrl);
  successUrl.searchParams.set("payment", "success");
  successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  successUrl.searchParams.set("order_id", orderId);

  return successUrl.toString();
};

const buildCancelUrl = (config: IStripeConfig, orderId: string) => {
  const cancelUrl = new URL(config.cancelUrl);
  cancelUrl.searchParams.set("payment", "cancel");
  cancelUrl.searchParams.set("order_id", orderId);

  return cancelUrl.toString();
};

const createCheckoutSession = async (
  payload: IStripeCheckoutSessionPayload,
  config: IStripeConfig,
): Promise<IStripeCheckoutSessionResult> => {
  const formData = new URLSearchParams();
  formData.set("mode", "payment");
  formData.set("customer_email", payload.email);
  formData.set("client_reference_id", payload.orderId);
  formData.set("success_url", buildSuccessUrl(config, payload.orderId));
  formData.set("cancel_url", buildCancelUrl(config, payload.orderId));
  formData.set("metadata[orderId]", payload.orderId);
  formData.set("metadata[orderNumber]", payload.orderNumber);
  formData.set("metadata[paymentId]", payload.paymentId);
  formData.set("metadata[transactionId]", payload.transactionId);
  formData.set("payment_intent_data[metadata][orderId]", payload.orderId);
  formData.set("payment_intent_data[metadata][orderNumber]", payload.orderNumber);
  formData.set("payment_intent_data[metadata][paymentId]", payload.paymentId);

  addLineItemsToPayload(formData, payload.lineItems, config.currency);

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });

  const rawResponse = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const errorMessage = getErrorMessage(rawResponse);

    throw new AppError(
      httpStatus.BAD_GATEWAY,
      errorMessage
        ? `Stripe checkout session creation failed: ${errorMessage}`
        : `Stripe checkout session creation failed with status ${response.status}`,
    );
  }

  if (!isRecord(rawResponse)) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "Stripe checkout session response was malformed",
    );
  }

  const sessionId = typeof rawResponse.id === "string" ? rawResponse.id : null;
  const checkoutUrl = typeof rawResponse.url === "string" ? rawResponse.url : null;

  if (!sessionId || !checkoutUrl) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "Stripe did not return session id or checkout URL",
    );
  }

  return {
    rawResponse,
    sessionId,
    checkoutUrl,
  };
};

const getCheckoutSession = async (
  sessionId: string,
  config: IStripeConfig,
): Promise<IStripeCheckoutSessionLookupResult> => {
  const sessionUrl = new URL(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
  sessionUrl.searchParams.set("expand[]", "payment_intent");

  const response = await fetch(sessionUrl.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
    },
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });

  const rawResponse = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const errorMessage = getErrorMessage(rawResponse);

    throw new AppError(
      httpStatus.BAD_GATEWAY,
      errorMessage
        ? `Stripe checkout session lookup failed: ${errorMessage}`
        : `Stripe checkout session lookup failed with status ${response.status}`,
    );
  }

  if (!isRecord(rawResponse)) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "Stripe checkout lookup response was malformed",
    );
  }

  const resolvedSessionId =
    typeof rawResponse.id === "string" ? rawResponse.id : sessionId;
  const status = normalizeStatus(rawResponse.status);
  const paymentStatus = normalizeStatus(rawResponse.payment_status);
  const paymentIntentId =
    typeof rawResponse.payment_intent === "string"
      ? rawResponse.payment_intent
      : undefined;

  return {
    rawResponse,
    sessionId: resolvedSessionId,
    status,
    paymentStatus,
    paymentIntentId,
  };
};

export const StripeService = {
  createCheckoutSession,
  getCheckoutSession,
};
