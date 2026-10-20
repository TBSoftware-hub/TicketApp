-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "maxGrade" INTEGER,
ADD COLUMN     "minGrade" INTEGER,
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false;

-- Grade limits only make sense on students-only tickets, and the range has to be the right way round.
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_grade_range_check" CHECK (
  ("minGrade" IS NULL OR "minGrade" BETWEEN 1 AND 12)
  AND ("maxGrade" IS NULL OR "maxGrade" BETWEEN 1 AND 12)
  AND ("minGrade" IS NULL OR "maxGrade" IS NULL OR "minGrade" <= "maxGrade")
  AND ("studentsOnly" OR ("minGrade" IS NULL AND "maxGrade" IS NULL))
);
