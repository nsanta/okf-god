import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Bench-local vitest config. Run from the repo root with:
 *   npx vitest run --config bench/vitest.config.ts
 *
 * `root` is resolved to this file's directory (bench/) so the config is
 * independent of the caller's cwd; include matches every bench/test/*.test.ts
 * file (recursively).
 * The root vitest.config.ts (tests/**) is intentionally untouched, so
 * `npm test` never runs bench tests.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
  },
});
