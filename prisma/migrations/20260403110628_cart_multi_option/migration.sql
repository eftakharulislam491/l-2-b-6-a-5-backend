-- DropIndex
DROP INDEX "cart_items_cartId_variantOptionId_key";

-- AlterTable
ALTER TABLE "cart_items" ADD COLUMN     "selectionKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "variantOptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "variantOptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "cart_items_cartId_selectionKey_idx" ON "cart_items"("cartId", "selectionKey");
