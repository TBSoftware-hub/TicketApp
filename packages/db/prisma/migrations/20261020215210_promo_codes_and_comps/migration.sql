-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'AMOUNT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "compedById" UUID,
ADD COLUMN     "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "promoCodeId" UUID;

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "discountType" "DiscountType" NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "maxUses" INTEGER,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PromoCodeToTicketType" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_PromoCodeToTicketType_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_eventId_code_key" ON "PromoCode"("eventId", "code");

-- CreateIndex
CREATE INDEX "_PromoCodeToTicketType_B_index" ON "_PromoCodeToTicketType"("B");

-- CreateIndex
CREATE INDEX "Order_promoCodeId_idx" ON "Order"("promoCodeId");

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_compedById_fkey" FOREIGN KEY ("compedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromoCodeToTicketType" ADD CONSTRAINT "_PromoCodeToTicketType_A_fkey" FOREIGN KEY ("A") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromoCodeToTicketType" ADD CONSTRAINT "_PromoCodeToTicketType_B_fkey" FOREIGN KEY ("B") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backstops for what the API validates.
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_values_check" CHECK (
  "code" = upper("code")
  AND "discountValue" > 0
  AND ("discountType" <> 'PERCENT' OR "discountValue" <= 100)
  AND ("maxUses" IS NULL OR "maxUses" >= 1)
  AND ("validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" > "validFrom")
);
