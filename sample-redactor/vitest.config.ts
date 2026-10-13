import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: { alias: { "@": new URL("./", import.meta.url).pathname } },
});
