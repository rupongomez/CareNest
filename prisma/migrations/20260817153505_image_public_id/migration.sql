/*
  Warnings:

  - You are about to drop the column `image_public_id` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "image_public_id",
ADD COLUMN     "imagePublicId" TEXT NOT NULL DEFAULT '';
