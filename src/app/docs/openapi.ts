import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { envVars } from "../config/env";
import {
  changePasswordZodSchema,
  forgotPasswordZodSchema,
  loginZodSchema,
  refreshTokenZodSchema,
  registerZodSchema,
  resetPasswordZodSchema,
} from "../modules/auth/auth.validation";
import {
  addCartItemZodSchema,
  updateCartItemZodSchema,
} from "../modules/cart/cart.validation";
import {
  createCategoryZodSchema,
  updateCategoryZodSchema,
} from "../modules/category/category.validation";
import { createMediaZodSchema } from "../modules/image/image.validation";
import {
  createOrderZodSchema,
  updateOrderStatusZodSchema,
} from "../modules/order/order.validation";
import {
  initiatePaymentZodSchema,
  stripeSessionValidationZodSchema,
} from "../modules/payment/payment.validation";
import {
  createProductZodSchema,
  updateProductZodSchema,
} from "../modules/product/product.validation";
import {
  createReviewZodSchema,
  moderateReviewZodSchema,
  replyReviewZodSchema,
  updateMyReviewZodSchema,
} from "../modules/review/review.validation";
import {
  adminUpdateUserZodSchema,
  createAddressZodSchema,
  updateAddressZodSchema,
  updateMeZodSchema,
} from "../modules/user/user.validation";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

const genericSuccessSchema = registry.register(
  "GenericSuccessResponse",
  z
    .object({
      success: z.boolean().optional(),
      message: z.string().optional(),
      data: z.unknown().optional(),
    })
    .passthrough(),
);

const genericErrorSchema = registry.register(
  "GenericErrorResponse",
  z
    .object({
      success: z.boolean().optional(),
      message: z.string().optional(),
      error: z.unknown().optional(),
    })
    .passthrough(),
);

const orderIdParamSchema = z.object({
  orderId: z.string().openapi({
    param: {
      name: "orderId",
      in: "path",
      required: true,
    },
  }),
});

const idParamSchema = z.object({
  id: z.string().openapi({
    param: {
      name: "id",
      in: "path",
      required: true,
    },
  }),
});

const addressIdParamSchema = z.object({
  addressId: z.string().openapi({
    param: {
      name: "addressId",
      in: "path",
      required: true,
    },
  }),
});

const paymentIdParamSchema = z.object({
  paymentId: z.string().openapi({
    param: {
      name: "paymentId",
      in: "path",
      required: true,
    },
  }),
});

const itemIdParamSchema = z.object({
  itemId: z.string().openapi({
    param: {
      name: "itemId",
      in: "path",
      required: true,
    },
  }),
});

const productIdParamSchema = z.object({
  productId: z.string().openapi({
    param: {
      name: "productId",
      in: "path",
      required: true,
    },
  }),
});

const jsonResponse = (
  description: string,
  schema: z.ZodTypeAny = genericSuccessSchema,
) => ({
  description,
  content: {
    "application/json": {
      schema,
    },
  },
});

const authSecurity = [{ bearerAuth: [] as string[] }];

// Auth module
registry.registerPath({
  method: "post",
  path: "/api/auth/register",
  tags: ["Auth"],
  summary: "Register a new user",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: registerZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("User registered successfully"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  tags: ["Auth"],
  summary: "Login with credentials",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: loginZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Login successful"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/refresh-token",
  tags: ["Auth"],
  summary: "Generate a new access token",
  request: {
    body: {
      content: {
        "application/json": {
          schema: refreshTokenZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Access token generated"),
    401: jsonResponse("Unauthorized", genericErrorSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  tags: ["Auth"],
  summary: "Logout current user",
  responses: {
    200: jsonResponse("Logout successful"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/change-password",
  tags: ["Auth"],
  summary: "Change password for authenticated user",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: changePasswordZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Password changed successfully"),
    401: jsonResponse("Unauthorized", genericErrorSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/forgot-password",
  tags: ["Auth"],
  summary: "Send forgot password email",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: forgotPasswordZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Reset instructions sent"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/reset-password",
  tags: ["Auth"],
  summary: "Reset password with token",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: resetPasswordZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Password reset successful"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/google",
  tags: ["Auth"],
  summary: "Initiate Google OAuth login",
  request: {
    query: z.object({
      redirect: z.string().optional(),
    }),
  },
  responses: {
    302: {
      description: "Redirect to Google OAuth",
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/google/callback",
  tags: ["Auth"],
  summary: "Google OAuth callback",
  responses: {
    302: {
      description: "Redirect to frontend",
    },
  },
});

// User module
registry.registerPath({
  method: "get",
  path: "/api/user",
  tags: ["User"],
  summary: "Get all users",
  security: authSecurity,
  responses: {
    200: jsonResponse("Users fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/user/profile/{id}",
  tags: ["User"],
  summary: "Get single user by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("User fetched successfully"),
    404: jsonResponse("User not found", genericErrorSchema),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/user/update-profile/{id}",
  tags: ["User"],
  summary: "Update user by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: adminUpdateUserZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("User updated successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/user/profile",
  tags: ["User"],
  summary: "Get current user profile",
  security: authSecurity,
  responses: {
    200: jsonResponse("Profile fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/user/profile",
  tags: ["User"],
  summary: "Update current user profile",
  security: authSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: updateMeZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Profile updated successfully"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/user/addresses",
  tags: ["User"],
  summary: "Create a new address",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createAddressZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Address created successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/user/addresses",
  tags: ["User"],
  summary: "Get current user addresses",
  security: authSecurity,
  responses: {
    200: jsonResponse("Addresses fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/user/addresses/{addressId}",
  tags: ["User"],
  summary: "Update an address",
  security: authSecurity,
  request: {
    params: addressIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: updateAddressZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Address updated successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/user/addresses/set-default/{addressId}",
  tags: ["User"],
  summary: "Set address as default",
  security: authSecurity,
  request: {
    params: addressIdParamSchema,
  },
  responses: {
    200: jsonResponse("Default address set successfully"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/user/addresses/{addressId}",
  tags: ["User"],
  summary: "Delete an address",
  security: authSecurity,
  request: {
    params: addressIdParamSchema,
  },
  responses: {
    200: jsonResponse("Address deleted successfully"),
  },
});

// Category module
registry.registerPath({
  method: "post",
  path: "/api/category",
  tags: ["Category"],
  summary: "Create category",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createCategoryZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Category created successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/category",
  tags: ["Category"],
  summary: "Get all categories",
  security: authSecurity,
  responses: {
    200: jsonResponse("Categories fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/category/collections",
  tags: ["Category"],
  summary: "Get public collections",
  responses: {
    200: jsonResponse("Collections fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/category/{id}",
  tags: ["Category"],
  summary: "Update category by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: updateCategoryZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Category updated successfully"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/category/{id}",
  tags: ["Category"],
  summary: "Delete category by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Category deleted successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/category/{id}",
  tags: ["Category"],
  summary: "Get category by id",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Category fetched successfully"),
  },
});

// Product module
registry.registerPath({
  method: "post",
  path: "/api/product",
  tags: ["Product"],
  summary: "Create product",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createProductZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Product created successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/product",
  tags: ["Product"],
  summary: "Get all products",
  responses: {
    200: jsonResponse("Products fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/product/{id}",
  tags: ["Product"],
  summary: "Get product by id",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Product fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/product/{id}",
  tags: ["Product"],
  summary: "Update product by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: updateProductZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Product updated successfully"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/product/{id}",
  tags: ["Product"],
  summary: "Delete product by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Product deleted successfully"),
  },
});

// Order module
registry.registerPath({
  method: "post",
  path: "/api/order",
  tags: ["Order"],
  summary: "Create order from cart",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createOrderZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Order created successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/order/my-orders",
  tags: ["Order"],
  summary: "Get authenticated user's orders",
  security: authSecurity,
  responses: {
    200: jsonResponse("Orders fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/order/my-orders/{id}",
  tags: ["Order"],
  summary: "Get authenticated user's order by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Order fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/order",
  tags: ["Order"],
  summary: "Get all orders",
  security: authSecurity,
  responses: {
    200: jsonResponse("All orders fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/order/{id}",
  tags: ["Order"],
  summary: "Get single order by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Order fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/order/{id}/status",
  tags: ["Order"],
  summary: "Update order status",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateOrderStatusZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Order status updated successfully"),
  },
});

// Cart module
registry.registerPath({
  method: "get",
  path: "/api/cart",
  tags: ["Cart"],
  summary: "Get current user's cart",
  security: authSecurity,
  responses: {
    200: jsonResponse("Cart fetched successfully"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/cart/items",
  tags: ["Cart"],
  summary: "Add an item to cart",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: addCartItemZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Item added to cart"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/cart/items/{itemId}",
  tags: ["Cart"],
  summary: "Update cart item quantity",
  security: authSecurity,
  request: {
    params: itemIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateCartItemZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Cart item updated"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/cart/items/{itemId}",
  tags: ["Cart"],
  summary: "Remove an item from cart",
  security: authSecurity,
  request: {
    params: itemIdParamSchema,
  },
  responses: {
    200: jsonResponse("Item removed from cart"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/cart/clear",
  tags: ["Cart"],
  summary: "Clear cart",
  security: authSecurity,
  responses: {
    200: jsonResponse("Cart cleared successfully"),
  },
});

// Image module
registry.registerPath({
  method: "post",
  path: "/api/image/upload",
  tags: ["Image"],
  summary: "Upload images",
  security: authSecurity,
  request: {
    body: {
      content: {
        "application/json": {
          schema: createMediaZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Images uploaded successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/image",
  tags: ["Image"],
  summary: "Get all images",
  security: authSecurity,
  responses: {
    200: jsonResponse("Images fetched successfully"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/image/{id}",
  tags: ["Image"],
  summary: "Delete image by id",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Image deleted successfully"),
  },
});

// Review module
registry.registerPath({
  method: "get",
  path: "/api/review/product/{productId}",
  tags: ["Review"],
  summary: "Get public reviews by product",
  request: {
    params: productIdParamSchema,
  },
  responses: {
    200: jsonResponse("Reviews fetched successfully"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/review",
  tags: ["Review"],
  summary: "Create review",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createReviewZodSchema,
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Review created successfully"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/review/my-reviews",
  tags: ["Review"],
  summary: "Get authenticated user's reviews",
  security: authSecurity,
  responses: {
    200: jsonResponse("My reviews fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/review/{id}",
  tags: ["Review"],
  summary: "Update own review",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateMyReviewZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Review updated successfully"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/review/{id}",
  tags: ["Review"],
  summary: "Replace own review",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateMyReviewZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Review updated successfully"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/review/{id}",
  tags: ["Review"],
  summary: "Delete own review",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Review deleted successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/review",
  tags: ["Review"],
  summary: "Get all reviews (admin)",
  security: authSecurity,
  responses: {
    200: jsonResponse("All reviews fetched successfully"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/review/{id}/admin",
  tags: ["Review"],
  summary: "Get review by id for admin",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Review fetched successfully"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/review/{id}/moderate",
  tags: ["Review"],
  summary: "Moderate review",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: moderateReviewZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Review moderated successfully"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/review/{id}/reply",
  tags: ["Review"],
  summary: "Reply to review",
  security: authSecurity,
  request: {
    params: idParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: replyReviewZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Review reply updated successfully"),
    400: jsonResponse("Validation error", genericErrorSchema),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/review/{id}/admin",
  tags: ["Review"],
  summary: "Delete review by admin",
  security: authSecurity,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: jsonResponse("Review deleted successfully"),
  },
});

// Payment module
registry.registerPath({
  method: "get",
  path: "/api/payment/ssl/success",
  tags: ["Payment"],
  summary: "SSL success callback (GET)",
  responses: {
    200: jsonResponse("SSL success callback handled"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/ssl/success",
  tags: ["Payment"],
  summary: "SSL success callback (POST)",
  responses: {
    200: jsonResponse("SSL success callback handled"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payment/ssl/fail",
  tags: ["Payment"],
  summary: "SSL fail callback (GET)",
  responses: {
    200: jsonResponse("SSL fail callback handled"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/ssl/fail",
  tags: ["Payment"],
  summary: "SSL fail callback (POST)",
  responses: {
    200: jsonResponse("SSL fail callback handled"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payment/ssl/cancel",
  tags: ["Payment"],
  summary: "SSL cancel callback (GET)",
  responses: {
    200: jsonResponse("SSL cancel callback handled"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/ssl/cancel",
  tags: ["Payment"],
  summary: "SSL cancel callback (POST)",
  responses: {
    200: jsonResponse("SSL cancel callback handled"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/ssl/validate",
  tags: ["Payment"],
  summary: "Validate SSL callback payload",
  responses: {
    200: jsonResponse("SSL callback validated"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/ssl/ipn",
  tags: ["Payment"],
  summary: "SSL IPN callback",
  responses: {
    200: jsonResponse("SSL IPN handled"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/success",
  tags: ["Payment"],
  summary: "Mark payment success",
  responses: {
    200: jsonResponse("Payment marked as success"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/fail",
  tags: ["Payment"],
  summary: "Mark payment fail",
  responses: {
    200: jsonResponse("Payment marked as failed"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/cancel",
  tags: ["Payment"],
  summary: "Mark payment cancel",
  responses: {
    200: jsonResponse("Payment marked as cancelled"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/validate-payment",
  tags: ["Payment"],
  summary: "Validate payment",
  responses: {
    200: jsonResponse("Payment validated"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/stripe/verify",
  tags: ["Payment"],
  summary: "Verify Stripe checkout session",
  security: authSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: stripeSessionValidationZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Stripe payment verification processed"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/{orderId}/initiate",
  tags: ["Payment"],
  summary: "Initiate payment by order id",
  security: authSecurity,
  request: {
    params: orderIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: initiatePaymentZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Payment initiated"),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payment/init-payment/{orderId}",
  tags: ["Payment"],
  summary: "Alternative initiate payment endpoint",
  security: authSecurity,
  request: {
    params: orderIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: initiatePaymentZodSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Payment initiated"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payment/invoice/{paymentId}",
  tags: ["Payment"],
  summary: "Get invoice download URL",
  security: authSecurity,
  request: {
    params: paymentIdParamSchema,
  },
  responses: {
    200: jsonResponse("Invoice URL fetched"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payment/invoice/{paymentId}/download",
  tags: ["Payment"],
  summary: "Download invoice file",
  security: authSecurity,
  request: {
    params: paymentIdParamSchema,
  },
  responses: {
    200: jsonResponse("Invoice downloaded"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payment/my/{orderId}",
  tags: ["Payment"],
  summary: "Get own payment by order id",
  security: authSecurity,
  request: {
    params: orderIdParamSchema,
  },
  responses: {
    200: jsonResponse("Payment fetched"),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payment/{orderId}",
  tags: ["Payment"],
  summary: "Get payment by order id for admin/manager",
  security: authSecurity,
  request: {
    params: orderIdParamSchema,
  },
  responses: {
    200: jsonResponse("Payment fetched"),
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "E-Commerce API",
    version: "1.0.0",
    description: "Auto generated API docs from Zod schemas",
  },
  servers: [
    {
      url: `http://localhost:${envVars.PORT}`,
      description: "Local development",
    },
  ],
  tags: [
    { name: "Auth", description: "Authentication endpoints" },
    { name: "User", description: "User profile endpoints" },
    { name: "Category", description: "Category endpoints" },
    { name: "Product", description: "Product endpoints" },
    { name: "Order", description: "Order endpoints" },
    { name: "Cart", description: "Cart endpoints" },
    { name: "Image", description: "Image endpoints" },
    { name: "Review", description: "Review endpoints" },
    { name: "Payment", description: "Payment endpoints" },
  ],
});
