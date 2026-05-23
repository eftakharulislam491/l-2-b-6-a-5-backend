import { z } from "zod";

export const addCartItemZodSchema = z.object({
  productId: z.string().uuid({ message: "productId must be a valid UUID" }),
  optionIds: z
    .array(z.string().uuid({ message: "Each optionId must be a valid UUID" }))
    .optional()
    .superRefine((ids, ctx) => {
      if (!ids?.length) {
        return;
      }

      const seen = new Set<string>();

      ids.forEach((id, index) => {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: "Duplicate optionId is not allowed",
          });
          return;
        }

        seen.add(id);
      });
    }),
  variantOptionId: z
    .string()
    .uuid({ message: "variantOptionId must be a valid UUID" })
    .optional(),
  variantOptionIds: z
    .array(z.string().uuid({ message: "Each variantOptionId must be a valid UUID" }))
    .optional()
    .superRefine((ids, ctx) => {
      if (!ids?.length) {
        return;
      }

      const seen = new Set<string>();

      ids.forEach((id, index) => {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: "Duplicate variantOptionId is not allowed",
          });
          return;
        }

        seen.add(id);
      });
    }),
  quantity: z.coerce
    .number()
    .int({ message: "quantity must be an integer" })
    .min(1, { message: "quantity must be at least 1" })
    .max(100, { message: "quantity cannot exceed 100" })
    .optional(),
}).superRefine((payload, ctx) => {
  if (
    !payload.variantOptionId &&
    !payload.variantOptionIds?.length &&
    !payload.optionIds?.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["variantOptionId"],
      message: "variantOptionId or variantOptionIds or optionIds is required",
    });
  }
});

export const updateCartItemZodSchema = z.object({
  quantity: z.coerce
    .number()
    .int({ message: "quantity must be an integer" })
    .min(1, { message: "quantity must be at least 1" })
    .max(100, { message: "quantity cannot exceed 100" }),
});
