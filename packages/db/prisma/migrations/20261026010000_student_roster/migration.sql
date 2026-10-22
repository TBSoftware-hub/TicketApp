-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "rosterImportedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RosterStudent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "studentId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "grade" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RosterStudent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RosterStudent_organizationId_studentId_key" ON "RosterStudent"("organizationId", "studentId");

-- AddForeignKey
ALTER TABLE "RosterStudent" ADD CONSTRAINT "RosterStudent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

