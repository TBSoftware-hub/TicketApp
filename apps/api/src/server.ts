import { createPrismaClient } from "@ticketapp/db";
import { buildApp } from "./app";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

const prisma = createPrismaClient();
const app = await buildApp({ prisma }, { logger: true });
app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
