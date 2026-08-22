-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "payerReference" DROP NOT NULL,
ALTER COLUMN "paidAt" DROP NOT NULL;
