import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The room's own config, so vitest does not walk up to the web app's vite.config.ts.
// Tests never touch your real ~/.config/room: settings, secrets, and the room index go to a scratch dir.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup-env.ts"],
    env: { ROOM_CONFIG_DIR: mkdtempSync(join(tmpdir(), "room-config-")), OPENROUTER_API_KEY: "" },
  },
});
