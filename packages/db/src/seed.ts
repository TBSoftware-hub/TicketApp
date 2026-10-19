import "dotenv/config";
import { createPrismaClient } from "./index";
import { seed } from "./seed-data";

const prisma = createPrismaClient();
try {
  const { org, event } = await seed(prisma);
  console.log(`Seeded ${org.name}: ${event.name}`);
} finally {
  await prisma.$disconnect();
}
