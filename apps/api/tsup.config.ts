import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // Bundle the workspace packages' TypeScript source into the API build.
  noExternal: ["@ticketapp/shared", "@ticketapp/db"],
});
