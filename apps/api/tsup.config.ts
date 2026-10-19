import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // Bundle the shared package's TypeScript source into the API build.
  noExternal: ["@ticketapp/shared"],
});
