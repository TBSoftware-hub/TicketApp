-- AlterTable
ALTER TABLE "WaiverTemplate" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "fields" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "WaiverTemplateVersion" (
    "id" UUID NOT NULL,
    "waiverTemplateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "requiresGuardianForMinors" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaiverTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaiverTemplateVersion_waiverTemplateId_version_key" ON "WaiverTemplateVersion"("waiverTemplateId", "version");

-- AddForeignKey
ALTER TABLE "WaiverTemplateVersion" ADD CONSTRAINT "WaiverTemplateVersion_waiverTemplateId_fkey" FOREIGN KEY ("waiverTemplateId") REFERENCES "WaiverTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Keep the current wording of waivers made before versions were recorded.
INSERT INTO "WaiverTemplateVersion" ("id", "waiverTemplateId", "version", "title", "body", "fields", "requiresGuardianForMinors", "createdAt")
SELECT gen_random_uuid(), "id", "version", "title", "body", "fields", "requiresGuardianForMinors", "updatedAt"
FROM "WaiverTemplate";
