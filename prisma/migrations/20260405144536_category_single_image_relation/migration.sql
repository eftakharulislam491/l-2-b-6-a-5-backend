-- Normalize legacy values. If "image" contains a plain URL or unknown id,
-- set it to NULL before adding the foreign key.
UPDATE "categories" c
SET "image" = NULL
WHERE c."image" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "product_images" p
    WHERE p."id" = c."image"
  );

-- CreateIndex
CREATE INDEX "categories_image_idx" ON "categories"("image");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_image_fkey" FOREIGN KEY ("image") REFERENCES "product_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
