/*
  Warnings:

  - You are about to drop the column `refundedReason` on the `payments` table. All the data in the column will be lost.
  - You are about to drop the column `refundedTime` on the `payments` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "payments" DROP COLUMN "refundedReason",
DROP COLUMN "refundedTime",
ADD COLUMN     "refundReason" TEXT,
ADD COLUMN     "refundTime" TEXT;
