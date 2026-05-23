import httpStatus from "http-status-codes";
import type { Prisma } from "../../../../generated/prisma/client";
import { envVars } from "../../config/env";
import AppError from "../../helper/AppError";
import { prisma } from "../../lib/prisma";
import { sendEmail } from "../../utils/sendEmail";
import type {
  ICreateOrderPaymentPayload,
  IInitiatePaymentPayload,
  IInvoiceSummary,
  IStripeSessionValidationPayload,
  ISslCommerzValidationPayload,
  TOrderStatus,
  TPaymentMethod,
} from "./payment.interface";
import type {
  IStripeConfig,
  IStripeCheckoutLineItemPayload,
} from "./providers/stripe.interface";
import type {
  ISslCommerzConfig,
  ISslCommerzInitPayload,
} from "./providers/sslCommerz.interface";
import { StripeService } from "./providers/stripe.service";
import { SslCommerzService } from "./providers/sslCommerz.service";

const sslMethodSet = new Set<TPaymentMethod>([
  "BKASH",
  "NAGAD",
  "ROCKET",
  "CREDIT_CARD",
  "BANK_TRANSFER",
]);

const stripeMethodSet = new Set<TPaymentMethod>(["STRIPE"]);

const paymentSelect = {
  id: true,
  orderId: true,
  method: true,
  status: true,
  amount: true,
  transactionId: true,
  gatewayResponse: true,
  paidAt: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      total: true,
      subtotal: true,
      discountTotal: true,
      shippingCost: true,
      tax: true,
      placedAt: true,
      userId: true,
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
          street: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
        },
      },
      items: {
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          variantOptionId: true,
          variantOptionIds: true,
          productName: true,
          productSku: true,
          quantity: true,
          unitPrice: true,
          total: true,
        },
      },
    },
  },
} satisfies Prisma.PaymentSelect;

type TPaymentRecord = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;
type TPaymentOrderItem = TPaymentRecord["order"]["items"][number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toNumberOrNull = (value: unknown) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const normalizeOptionIds = (optionIds: string[]) =>
  [...new Set(optionIds.map((id) => id.trim()).filter(Boolean))].sort();

const getOrderItemOptionIds = (item: {
  variantOptionId: string;
  variantOptionIds: string[];
}) =>
  normalizeOptionIds(
    item.variantOptionIds.length ? item.variantOptionIds : [item.variantOptionId],
  );

const clearCartForUser = async (tx: Prisma.TransactionClient, userId: string) => {
  const cart = await tx.cart.findUnique({
    where: {
      userId,
    },
    select: {
      id: true,
    },
  });

  if (!cart) {
    return;
  }

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
      totalPrice: 0,
    },
  });
};

const finalizeOnlineOrderAfterPayment = async (
  tx: Prisma.TransactionClient,
  payment: TPaymentRecord,
  processedAt: Date,
) => {
  if (!payment.order.items.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Order has no items to finalize after payment",
    );
  }

  const quantityByOptionId = new Map<string, number>();

  for (const item of payment.order.items) {
    const optionIds = getOrderItemOptionIds(item);

    for (const optionId of optionIds) {
      quantityByOptionId.set(
        optionId,
        (quantityByOptionId.get(optionId) ?? 0) + item.quantity,
      );
    }
  }

  const optionIds = [...quantityByOptionId.keys()];
  const options = await tx.variantOption.findMany({
    where: {
      id: {
        in: optionIds,
      },
    },
    select: {
      id: true,
      sku: true,
      stock: true,
    },
  });

  if (options.length !== optionIds.length) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "One or more variant options were not found while finalizing order",
    );
  }

  const optionById = new Map(options.map((option) => [option.id, option]));

  for (const optionId of optionIds) {
    const option = optionById.get(optionId);
    const requiredQty = quantityByOptionId.get(optionId) ?? 0;

    if (!option) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        `Variant option '${optionId}' was not found`,
      );
    }

    if (option.stock < requiredQty) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for SKU '${option.sku}' during payment confirmation`,
      );
    }
  }

  for (const optionId of optionIds) {
    const option = optionById.get(optionId)!;
    const requiredQty = quantityByOptionId.get(optionId)!;

    const updated = await tx.variantOption.updateMany({
      where: {
        id: optionId,
        stock: {
          gte: requiredQty,
        },
      },
      data: {
        stock: {
          decrement: requiredQty,
        },
      },
    });

    if (updated.count === 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Insufficient stock for SKU '${option.sku}' during payment confirmation`,
      );
    }

    await tx.inventoryTransaction.create({
      data: {
        variantOptionId: option.id,
        type: "SALE",
        quantity: -requiredQty,
        previousStock: option.stock,
        newStock: option.stock - requiredQty,
        referenceId: payment.order.id,
        referenceType: "order",
        note: `Stock deducted after successful online payment for order ${payment.order.orderNumber}`,
        createdBy: payment.order.userId,
      },
    });
  }

  await clearCartForUser(tx, payment.order.userId);

  await tx.order.update({
    where: {
      id: payment.order.id,
    },
    data: {
      status: "CONFIRMED",
      processedAt,
    },
  });

  await tx.orderStatusHistory.create({
    data: {
      orderId: payment.order.id,
      status: "CONFIRMED",
      note: "Online payment confirmed and order finalized",
      changedBy: "system",
    },
  });
};

const mergeGatewayResponse = (
  current: Prisma.JsonValue | null,
  patch: Record<string, unknown>,
) => {
  if (isRecord(current)) {
    return {
      ...current,
      ...patch,
    } as Prisma.InputJsonValue;
  }

  return patch as Prisma.InputJsonValue;
};

const getNonEmptyTrimmedString = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  return normalized || null;
};

const extractStripeSessionIdFromGatewayResponse = (
  gatewayResponse: Prisma.JsonValue | null,
) => {
  if (!isRecord(gatewayResponse)) {
    return null;
  }

  const fromTopLevel = getNonEmptyTrimmedString(gatewayResponse.stripeSessionId);

  if (fromTopLevel) {
    return fromTopLevel;
  }

  const stripeSessionCreate = gatewayResponse.stripeSessionCreate;

  if (!isRecord(stripeSessionCreate)) {
    return null;
  }

  return getNonEmptyTrimmedString(stripeSessionCreate.id);
};

const extractStripeMetadata = (rawResponse: unknown) => {
  if (!isRecord(rawResponse)) {
    return {
      paymentId: null,
      transactionId: null,
      orderId: null,
    };
  }

  const sessionMetadata = isRecord(rawResponse.metadata) ? rawResponse.metadata : null;
  const paymentIntent =
    isRecord(rawResponse.payment_intent) ? rawResponse.payment_intent : null;
  const intentMetadata = paymentIntent && isRecord(paymentIntent.metadata)
    ? paymentIntent.metadata
    : null;

  return {
    paymentId:
      getNonEmptyTrimmedString(sessionMetadata?.paymentId) ??
      getNonEmptyTrimmedString(intentMetadata?.paymentId),
    transactionId:
      getNonEmptyTrimmedString(sessionMetadata?.transactionId) ??
      getNonEmptyTrimmedString(intentMetadata?.transactionId),
    orderId:
      getNonEmptyTrimmedString(sessionMetadata?.orderId) ??
      getNonEmptyTrimmedString(intentMetadata?.orderId),
  };
};

const ensureSslConfig = (): ISslCommerzConfig => {
  const missingKeys: string[] = [];

  if (!envVars.SSL?.STORE_ID) {
    missingKeys.push("SSL_STORE_ID");
  }

  if (!envVars.SSL?.STORE_PASS) {
    missingKeys.push("SSL_STORE_PASS");
  }

  if (!envVars.SSL?.PAYMENT_API) {
    missingKeys.push("SSL_PAYMENT_API");
  }

  if (!envVars.SSL?.VALIDATION_API) {
    missingKeys.push("SSL_VALIDATION_API");
  }

  if (!envVars.SSL?.SUCCESS_BACKEND_URL) {
    missingKeys.push("SSL_SUCCESS_BACKEND_URL");
  }

  if (!envVars.SSL?.FAIL_BACKEND_URL) {
    missingKeys.push("SSL_FAIL_BACKEND_URL");
  }

  if (!envVars.SSL?.CANCEL_BACKEND_URL) {
    missingKeys.push("SSL_CANCEL_BACKEND_URL");
  }

  if (!envVars.SSL?.IPN_URL) {
    missingKeys.push("SSL_IPN_URL");
  }

  if (missingKeys.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `SSLCommerz credentials are missing: ${missingKeys.join(", ")}`,
    );
  }

  return {
    storeId: envVars.SSL.STORE_ID!,
    storePass: envVars.SSL.STORE_PASS!,
    paymentApi: envVars.SSL.PAYMENT_API!,
    validationApi: envVars.SSL.VALIDATION_API!,
    successBackendUrl: envVars.SSL.SUCCESS_BACKEND_URL!,
    failBackendUrl: envVars.SSL.FAIL_BACKEND_URL!,
    cancelBackendUrl: envVars.SSL.CANCEL_BACKEND_URL!,
    ipnUrl: envVars.SSL.IPN_URL!,
  };
};

const ensureStripeConfig = (): IStripeConfig => {
  const missingKeys: string[] = [];

  if (!envVars.STRIPE?.SECRET_KEY) {
    missingKeys.push("STRIPE_SECRET_KEY");
  }

  if (missingKeys.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Stripe credentials are missing: ${missingKeys.join(", ")}`,
    );
  }

  return {
    secretKey: envVars.STRIPE.SECRET_KEY!,
    successUrl: envVars.STRIPE.SUCCESS_URL ?? `${envVars.FRONTEND_URL}/cart`,
    cancelUrl: envVars.STRIPE.CANCEL_URL ?? `${envVars.FRONTEND_URL}/cart`,
    currency: envVars.STRIPE.CURRENCY ?? "bdt",
  };
};

const buildSslCustomerAddress = (payment: TPaymentRecord) => {
  const addressParts = [
    payment.order.address.street,
    payment.order.address.city,
    payment.order.address.state,
  ].filter(Boolean);

  if (addressParts.length === 0) {
    return "N/A";
  }

  return addressParts.join(", ");
};

const buildStripeLineItems = (
  payment: TPaymentRecord,
): IStripeCheckoutLineItemPayload[] => {
  const lineItems = payment.order.items.map((item) => ({
    productName: item.productName,
    unitAmount: Number(item.unitPrice),
    quantity: item.quantity,
  }));

  if (Number(payment.order.shippingCost) > 0) {
    lineItems.push({
      productName: "Shipping",
      unitAmount: Number(payment.order.shippingCost),
      quantity: 1,
    });
  }

  if (Number(payment.order.tax) > 0) {
    lineItems.push({
      productName: "Tax",
      unitAmount: Number(payment.order.tax),
      quantity: 1,
    });
  }

  if (!lineItems.length) {
    lineItems.push({
      productName: `Order ${payment.order.orderNumber}`,
      unitAmount: Number(payment.amount),
      quantity: 1,
    });
  }

  return lineItems;
};

const getProviderInvoice = (
  gatewayResponse: Prisma.JsonValue | null,
): Record<string, unknown> | null => {
  if (!isRecord(gatewayResponse)) {
    return null;
  }

  const providerData: Record<string, unknown> = {};

  if ("sslInit" in gatewayResponse) {
    providerData.sslInit = gatewayResponse.sslInit;
  }

  if ("sslValidation" in gatewayResponse) {
    providerData.sslValidation = gatewayResponse.sslValidation;
  }

  if ("stripeSessionCreate" in gatewayResponse) {
    providerData.stripeSessionCreate = gatewayResponse.stripeSessionCreate;
  }

  if ("stripeSessionVerify" in gatewayResponse) {
    providerData.stripeSessionVerify = gatewayResponse.stripeSessionVerify;
  }

  if (Object.keys(providerData).length === 0) {
    return null;
  }

  return providerData;
};

const buildInvoiceSummary = (payment: TPaymentRecord): IInvoiceSummary => {
  const issuedAt = payment.paidAt ?? payment.createdAt;
  const invoiceNumber = `INV-${payment.order.orderNumber}`;

  return {
    paymentId: payment.id,
    invoiceNumber,
    orderId: payment.order.id,
    orderNumber: payment.order.orderNumber,
    customerName: payment.order.user.name ?? "Customer",
    customerEmail: payment.order.user.email,
    paymentMethod: payment.method as TPaymentMethod,
    paymentStatus: payment.status,
    transactionId: payment.transactionId,
    orderStatus: payment.order.status,
    issuedAt: issuedAt.toISOString(),
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
    subtotal: payment.order.subtotal.toString(),
    discountTotal: payment.order.discountTotal.toString(),
    shippingCost: payment.order.shippingCost.toString(),
    tax: payment.order.tax.toString(),
    total: payment.order.total.toString(),
    items: payment.order.items.map((item) => ({
      productName: item.productName,
      productSku: item.productSku,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toString(),
      total: item.total.toString(),
    })),
    providerInvoice: getProviderInvoice(payment.gatewayResponse),
  };
};

const renderInvoiceHtml = (invoice: IInvoiceSummary) => {
  const rows = invoice.items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.productName)}</td>
          <td>${escapeHtml(item.productSku)}</td>
          <td>${item.quantity}</td>
          <td>${item.unitPrice}</td>
          <td>${item.total}</td>
        </tr>
      `,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(invoice.invoiceNumber)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #111; }
      h1 { margin-bottom: 8px; }
      p { margin: 2px 0; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { border: 1px solid #d4d4d4; padding: 8px; text-align: left; }
      th { background: #f3f3f3; }
      .meta { margin-bottom: 16px; }
      .summary { margin-top: 16px; }
      .summary p { font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Invoice ${escapeHtml(invoice.invoiceNumber)}</h1>
    <div class="meta">
      <p><strong>Order:</strong> ${escapeHtml(invoice.orderNumber)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(invoice.customerName)} (${escapeHtml(
        invoice.customerEmail,
      )})</p>
      <p><strong>Payment:</strong> ${escapeHtml(invoice.paymentMethod)} / ${escapeHtml(
        invoice.paymentStatus,
      )}</p>
      <p><strong>Transaction:</strong> ${escapeHtml(invoice.transactionId ?? "N/A")}</p>
      <p><strong>Issued At:</strong> ${escapeHtml(invoice.issuedAt)}</p>
    </div>
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>SKU</th>
          <th>Qty</th>
          <th>Unit Price</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="summary">
      <p>Subtotal: ${escapeHtml(invoice.subtotal)}</p>
      <p>Discount: ${escapeHtml(invoice.discountTotal)}</p>
      <p>Shipping: ${escapeHtml(invoice.shippingCost)}</p>
      <p>Tax: ${escapeHtml(invoice.tax)}</p>
      <p>Grand Total: ${escapeHtml(invoice.total)}</p>
    </div>
  </body>
</html>
  `.trim();
};

const getPaymentByIdForUser = async (paymentId: string, userId: string) => {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      order: {
        userId,
      },
    },
    select: paymentSelect,
  });

  if (!payment) {
    throw new AppError(httpStatus.NOT_FOUND, "Payment not found");
  }

  return payment;
};

const getPaymentByIdForAdmin = async (paymentId: string) => {
  const payment = await prisma.payment.findUnique({
    where: {
      id: paymentId,
    },
    select: paymentSelect,
  });

  if (!payment) {
    throw new AppError(httpStatus.NOT_FOUND, "Payment not found");
  }

  return payment;
};

const getOwnedPaymentByOrder = async (orderId: string, userId: string) => {
  const payment = await prisma.payment.findFirst({
    where: {
      orderId,
      order: {
        userId,
      },
    },
    select: paymentSelect,
  });

  if (!payment) {
    throw new AppError(httpStatus.NOT_FOUND, "Payment not found");
  }

  return payment;
};

const getPaymentByOrderForAdmin = async (orderId: string) => {
  const payment = await prisma.payment.findUnique({
    where: {
      orderId,
    },
    select: paymentSelect,
  });

  if (!payment) {
    throw new AppError(httpStatus.NOT_FOUND, "Payment not found");
  }

  return payment;
};

const createOrderPayment = async (
  tx: Prisma.TransactionClient,
  payload: ICreateOrderPaymentPayload,
) => {
  const payment = await tx.payment.create({
    data: {
      orderId: payload.orderId,
      method: payload.method,
      status: "PENDING",
      amount: payload.amount,
      transactionId: null,
      paidAt: null,
      errorMessage: null,
    },
    select: {
      id: true,
      orderId: true,
      method: true,
      status: true,
      amount: true,
      transactionId: true,
      paidAt: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return payment;
};

const getInvoiceForUser = async (paymentId: string, userId: string) => {
  const payment = await getPaymentByIdForUser(paymentId, userId);

  return buildInvoiceSummary(payment);
};

const getInvoiceForAdmin = async (paymentId: string) => {
  const payment = await getPaymentByIdForAdmin(paymentId);

  return buildInvoiceSummary(payment);
};

const getInvoiceDownloadForUser = async (paymentId: string, userId: string) => {
  const invoice = await getInvoiceForUser(paymentId, userId);
  const html = renderInvoiceHtml(invoice);

  return {
    invoice,
    html,
    fileName: `${invoice.invoiceNumber}.html`,
  };
};

const getInvoiceDownloadForAdmin = async (paymentId: string) => {
  const invoice = await getInvoiceForAdmin(paymentId);
  const html = renderInvoiceHtml(invoice);

  return {
    invoice,
    html,
    fileName: `${invoice.invoiceNumber}.html`,
  };
};

const sendInvoiceEmailInternal = async (
  payment: TPaymentRecord,
  reason: "PAYMENT_SUCCESS" | "COD_ORDER_PLACED",
) => {
  const invoice = buildInvoiceSummary(payment);
  const invoiceHtml = renderInvoiceHtml(invoice);

  const existingInvoiceMeta =
    isRecord(payment.gatewayResponse) && isRecord(payment.gatewayResponse.invoice)
      ? payment.gatewayResponse.invoice
      : null;

  if (existingInvoiceMeta && typeof existingInvoiceMeta.emailSentAt === "string") {
    return;
  }

  const paymentNote =
    reason === "COD_ORDER_PLACED"
      ? "Cash on delivery selected. Please pay while receiving your order."
      : "Your payment has been completed successfully.";

  await sendEmail({
    to: invoice.customerEmail,
    subject: `Invoice ${invoice.invoiceNumber} - ${invoice.orderNumber}`,
    templateName: "orderInvoice",
    templateData: {
      customerName: invoice.customerName,
      invoiceNumber: invoice.invoiceNumber,
      orderNumber: invoice.orderNumber,
      paymentMethod: invoice.paymentMethod,
      paymentStatus: invoice.paymentStatus,
      transactionId: invoice.transactionId ?? "N/A",
      issuedAt: invoice.issuedAt,
      total: invoice.total,
      paymentNote,
      items: invoice.items,
    },
    attachments: [
      {
        filename: `${invoice.invoiceNumber}.html`,
        content: invoiceHtml,
        contentType: "text/html",
      },
    ],
  });

  await prisma.payment.update({
    where: {
      id: payment.id,
    },
    data: {
      gatewayResponse: mergeGatewayResponse(payment.gatewayResponse, {
        invoice: {
          emailSentAt: new Date().toISOString(),
          reason,
          invoiceNumber: invoice.invoiceNumber,
        },
      }),
    },
  });
};

const sendInvoiceEmailForOrder = async (orderId: string) => {
  const payment = await prisma.payment.findUnique({
    where: {
      orderId,
    },
    select: paymentSelect,
  });

  if (!payment) {
    return;
  }

  if (payment.method !== "CASH_ON_DELIVERY") {
    return;
  }

  await sendInvoiceEmailInternal(payment, "COD_ORDER_PLACED");
};

const sendInvoiceEmailForPaymentSuccess = async (paymentId: string) => {
  const payment = await prisma.payment.findUnique({
    where: {
      id: paymentId,
    },
    select: paymentSelect,
  });

  if (!payment) {
    return;
  }

  if (payment.status !== "SUCCESS") {
    return;
  }

  await sendInvoiceEmailInternal(payment, "PAYMENT_SUCCESS");
};

const syncPaymentWithOrderStatus = async (
  tx: Prisma.TransactionClient,
  orderId: string,
  nextStatus: TOrderStatus,
) => {
  const payment = await tx.payment.findUnique({
    where: { orderId },
    select: {
      id: true,
      method: true,
      status: true,
    },
  });

  if (!payment) {
    return null;
  }

  if (
    nextStatus === "DELIVERED" &&
    payment.method === "CASH_ON_DELIVERY" &&
    payment.status === "PENDING"
  ) {
    return tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: new Date(),
        errorMessage: null,
      },
      select: {
        id: true,
        method: true,
        status: true,
        paidAt: true,
      },
    });
  }

  if (
    nextStatus === "CANCELLED" &&
    (payment.status === "PENDING" || payment.status === "PROCESSING")
  ) {
    return tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        errorMessage:
          payment.method === "CASH_ON_DELIVERY"
            ? "Order cancelled before payment collection"
            : "Order cancelled before online payment completion",
      },
      select: {
        id: true,
        method: true,
        status: true,
        paidAt: true,
      },
    });
  }

  if (
    nextStatus === "REFUNDED" &&
    (payment.status === "SUCCESS" || payment.status === "PROCESSING")
  ) {
    return tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "REFUNDED",
      },
      select: {
        id: true,
        method: true,
        status: true,
        paidAt: true,
      },
    });
  }

  return payment;
};

const initiatePayment = async (payload: IInitiatePaymentPayload) => {
  const payment = await getOwnedPaymentByOrder(payload.orderId, payload.userId);

  if (payment.order.status === "CANCELLED") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Cannot initiate payment for a cancelled order",
    );
  }

  if (payment.status === "SUCCESS") {
    return {
      payment,
      requiresRedirect: false,
      gatewayPageUrl: null,
      message: "Payment is already completed",
    };
  }

  if (payment.method === "CASH_ON_DELIVERY") {
    return {
      payment,
      requiresRedirect: false,
      gatewayPageUrl: null,
      message: "Cash on delivery does not require gateway payment",
    };
  }

  if (stripeMethodSet.has(payment.method as TPaymentMethod)) {
    const transactionId =
      payment.transactionId ?? `STRIPE-${payment.order.orderNumber}-${Date.now()}`;
    const stripeResult = await StripeService.createCheckoutSession(
      {
        orderId: payment.order.id,
        orderNumber: payment.order.orderNumber,
        paymentId: payment.id,
        transactionId,
        email: payment.order.user.email,
        lineItems: buildStripeLineItems(payment),
      },
      ensureStripeConfig(),
    );

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "PROCESSING",
        transactionId: stripeResult.sessionId,
        gatewayResponse: mergeGatewayResponse(payment.gatewayResponse, {
          stripeSessionCreate: stripeResult.rawResponse,
          stripeSessionId: stripeResult.sessionId,
        }),
        errorMessage: null,
      },
      select: paymentSelect,
    });

    return {
      payment: updatedPayment,
      requiresRedirect: true,
      gatewayPageUrl: stripeResult.checkoutUrl,
      message: "Stripe checkout session created successfully",
    };
  }

  if (!sslMethodSet.has(payment.method as TPaymentMethod)) {
    throw new AppError(
      httpStatus.NOT_IMPLEMENTED,
      `${payment.method} payment initiation is not implemented yet`,
    );
  }

  const transactionId =
    payment.transactionId ?? `SSL-${payment.order.orderNumber}-${Date.now()}`;

  const sslPayload: ISslCommerzInitPayload = {
    amount: Number(payment.amount),
    transactionId,
    name: payment.order.user.name ?? "Customer",
    email: payment.order.user.email,
    phoneNumber: payment.order.user.phone ?? "N/A",
    address: buildSslCustomerAddress(payment),
  };

  const sslResult = await SslCommerzService.initPayment(
    sslPayload,
    ensureSslConfig(),
  );

  if (!sslResult.gatewayPageUrl) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "SSLCommerz did not return a gateway redirect URL",
    );
  }

  const updatedPayment = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "PROCESSING",
      transactionId,
      gatewayResponse: mergeGatewayResponse(payment.gatewayResponse, {
        sslInit: sslResult.rawResponse,
      }),
      errorMessage: null,
    },
    select: paymentSelect,
  });

  return {
    payment: updatedPayment,
    requiresRedirect: true,
    gatewayPageUrl: sslResult.gatewayPageUrl,
    message: "Payment initiated successfully",
  };
};

const validateSslPayment = async (payload: ISslCommerzValidationPayload) => {
  const tranId = payload.tranId.trim();

  const payment = await prisma.payment.findFirst({
    where: {
      transactionId: tranId,
    },
    select: paymentSelect,
  });

  if (!payment) {
    throw new AppError(httpStatus.NOT_FOUND, "Payment not found for transaction");
  }

  if (payment.method === "CASH_ON_DELIVERY") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This transaction does not belong to an online payment method",
    );
  }

  if (!sslMethodSet.has(payment.method as TPaymentMethod)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This transaction does not belong to SSLCommerz payment methods",
    );
  }

  if (payment.status === "SUCCESS") {
    return {
      payment,
      success: true,
      validationResponse: null,
    };
  }

  const callbackStatus = SslCommerzService.normalizeStatus(payload.status);

  if (
    (callbackStatus === "SUCCESS" ||
      callbackStatus === "VALID" ||
      callbackStatus === "VALIDATED") &&
    !payload.valId
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "val_id is required for successful payment validation",
    );
  }

  const sslConfig = ensureSslConfig();
  const validationResult = payload.valId
    ? await SslCommerzService.validatePayment(payload.valId, {
        validationApi: sslConfig.validationApi,
        storeId: sslConfig.storeId,
        storePass: sslConfig.storePass,
      })
    : null;

  const validationStatus = validationResult?.normalizedStatus;
  const validationPayload = validationResult?.rawResponse;

  if (validationPayload && isRecord(validationPayload)) {
    const validatedTranId = validationPayload.tran_id;

    if (typeof validatedTranId === "string" && validatedTranId !== tranId) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Transaction id mismatch in validation response",
      );
    }

    const validatedAmount = toNumberOrNull(validationPayload.amount);

    if (validatedAmount !== null) {
      const expectedAmount = Number(payment.amount);

      if (Math.abs(validatedAmount - expectedAmount) > 0.01) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "Payment amount mismatch in validation response",
        );
      }
    }
  }

  const isSuccess =
    validationStatus === "VALID" ||
    validationStatus === "VALIDATED" ||
    validationStatus === "SUCCESS" ||
    (!validationStatus &&
      (callbackStatus === "VALID" ||
        callbackStatus === "VALIDATED" ||
        callbackStatus === "SUCCESS"));

  const isCancelled = callbackStatus === "CANCEL" || callbackStatus === "CANCELED";

  const errorMessage = isSuccess
    ? null
    : isCancelled
      ? "Payment was cancelled by customer"
      : `Payment validation failed${callbackStatus ? ` (${callbackStatus})` : ""}`;

  const now = new Date();

  const updatedPayment = await prisma.$transaction(async (tx) => {
    const paymentAfterStatusUpdate = await tx.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        status: isSuccess ? "SUCCESS" : "FAILED",
        paidAt: isSuccess ? now : null,
        errorMessage,
        gatewayResponse: mergeGatewayResponse(payment.gatewayResponse, {
          sslCallback: {
            tran_id: tranId,
            val_id: payload.valId ?? null,
            status: payload.status ?? null,
            amount: payload.amount ?? null,
          },
          sslValidation: validationResult?.rawResponse ?? null,
        }),
      },
      select: paymentSelect,
    });

    if (isSuccess && paymentAfterStatusUpdate.order.status === "PENDING") {
      await finalizeOnlineOrderAfterPayment(tx, paymentAfterStatusUpdate, now);
    }

    const refreshedPayment = await tx.payment.findUnique({
      where: {
        id: payment.id,
      },
      select: paymentSelect,
    });

    if (!refreshedPayment) {
      throw new AppError(httpStatus.NOT_FOUND, "Payment not found");
    }

    return refreshedPayment;
  });

  if (isSuccess) {
    void sendInvoiceEmailForPaymentSuccess(updatedPayment.id).catch((error) => {
      console.error("Failed to send payment success invoice email", error);
    });
  }

  return {
    payment: updatedPayment,
    success: isSuccess,
    validationResponse: validationResult?.rawResponse ?? null,
  };
};

const validateStripeSession = async (payload: IStripeSessionValidationPayload) => {
  const sessionId = payload.sessionId.trim();
  let stripeConfig: IStripeConfig | null = null;
  const getStripeConfig = () => {
    stripeConfig ??= ensureStripeConfig();

    return stripeConfig;
  };

  let payment = await prisma.payment.findFirst({
    where: {
      transactionId: sessionId,
      order: {
        userId: payload.userId,
      },
    },
    select: paymentSelect,
  });

  if (!payment) {
    const candidatePayments = await prisma.payment.findMany({
      where: {
        method: "STRIPE",
        order: {
          userId: payload.userId,
        },
      },
      select: paymentSelect,
    });

    payment =
      candidatePayments.find(
        (candidate) =>
          extractStripeSessionIdFromGatewayResponse(candidate.gatewayResponse) ===
          sessionId,
      ) ?? null;
  }

  let stripeSession: Awaited<ReturnType<typeof StripeService.getCheckoutSession>> | null =
    null;

  if (!payment) {
    stripeSession = await StripeService.getCheckoutSession(sessionId, getStripeConfig());
    const stripeMetadata = extractStripeMetadata(stripeSession.rawResponse);

    if (stripeMetadata.paymentId) {
      payment = await prisma.payment.findFirst({
        where: {
          id: stripeMetadata.paymentId,
          order: {
            userId: payload.userId,
          },
        },
        select: paymentSelect,
      });
    }

    if (!payment && stripeMetadata.transactionId) {
      payment = await prisma.payment.findFirst({
        where: {
          transactionId: stripeMetadata.transactionId,
          order: {
            userId: payload.userId,
          },
        },
        select: paymentSelect,
      });
    }

    if (!payment && stripeMetadata.orderId) {
      payment = await prisma.payment.findFirst({
        where: {
          orderId: stripeMetadata.orderId,
          method: "STRIPE",
          order: {
            userId: payload.userId,
          },
        },
        select: paymentSelect,
      });
    }

    if (!payment) {
      throw new AppError(httpStatus.NOT_FOUND, "Payment not found for this session");
    }
  }

  if (payment.method !== "STRIPE") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "This session does not belong to a Stripe payment",
    );
  }

  if (payment.status === "SUCCESS") {
    return {
      payment,
      success: true,
      validationResponse: null,
    };
  }

  stripeSession ??= await StripeService.getCheckoutSession(
    sessionId,
    getStripeConfig(),
  );
  const isSuccess =
    stripeSession.paymentStatus === "paid" || stripeSession.status === "complete";
  const isCancelled =
    stripeSession.status === "expired" ||
    stripeSession.status === "canceled" ||
    stripeSession.status === "cancelled";
  const nextStatus = isSuccess ? "SUCCESS" : isCancelled ? "FAILED" : payment.status;
  const errorMessage = isSuccess
    ? null
    : isCancelled
      ? "Stripe checkout session was cancelled or expired"
      : payment.errorMessage;
  const now = new Date();

  const updatedPayment = await prisma.$transaction(async (tx) => {
    const paymentAfterStatusUpdate = await tx.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        status: nextStatus,
        paidAt: isSuccess ? now : null,
        errorMessage,
        gatewayResponse: mergeGatewayResponse(payment.gatewayResponse, {
          stripeSessionVerify: stripeSession.rawResponse,
          stripePaymentIntentId: stripeSession.paymentIntentId ?? null,
        }),
      },
      select: paymentSelect,
    });

    if (isSuccess && paymentAfterStatusUpdate.order.status === "PENDING") {
      await finalizeOnlineOrderAfterPayment(tx, paymentAfterStatusUpdate, now);
    }

    const refreshedPayment = await tx.payment.findUnique({
      where: {
        id: payment.id,
      },
      select: paymentSelect,
    });

    if (!refreshedPayment) {
      throw new AppError(httpStatus.NOT_FOUND, "Payment not found");
    }

    return refreshedPayment;
  });

  if (isSuccess) {
    void sendInvoiceEmailForPaymentSuccess(updatedPayment.id).catch((error) => {
      console.error("Failed to send payment success invoice email", error);
    });
  }

  return {
    payment: updatedPayment,
    success: isSuccess,
    validationResponse: stripeSession.rawResponse,
  };
};

export const PaymentService = {
  createOrderPayment,
  syncPaymentWithOrderStatus,
  initiatePayment,
  validateSslPayment,
  validateStripeSession,
  getOwnedPaymentByOrder,
  getPaymentByOrderForAdmin,
  getInvoiceForUser,
  getInvoiceForAdmin,
  getInvoiceDownloadForUser,
  getInvoiceDownloadForAdmin,
  sendInvoiceEmailForOrder,
  sendInvoiceEmailForPaymentSuccess,
};
