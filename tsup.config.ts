import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vitest: "src/adapters/vitest.ts",
    jest: "src/adapters/jest.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node18",
  platform: "node",
  treeshake: true,
});
