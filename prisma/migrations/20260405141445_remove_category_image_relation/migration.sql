/*
  Warnings:

  - You are about to drop the column `categoryId` on the `product_images` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "product_images" DROP CONSTRAINT "product_images_categoryId_fkey";

-- DropIndex
DROP INDEX "product_images_categoryId_idx";

-- AlterTable
ALTER TABLE "product_images" DROP COLUMN "categoryId";
