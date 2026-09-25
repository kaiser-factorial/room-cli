import { defineConfig } from "vitest/config";

// The room's own config, so vitest does not walk up to the web app's vite.config.ts.
export default defineConfig({ esbuild: { jsx: "automatic" }, test: { include: ["test/**/*.test.{ts,tsx}"] } });
