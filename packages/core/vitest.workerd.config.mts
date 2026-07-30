import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// pool-workers v4 API (0.18.x): the pool is a Vite plugin, `cloudflareTest`,
// taking what used to be `test.poolOptions.workers` as its argument — not the
// old `defineWorkersProject` from the removed `/config` subpath. Same shape as
// canonical-hours/packages/vespers/vitest.workerd.config.mts.
//
// No `compatibilityFlags` here, deliberately. This package's entire claim is
// that it needs nothing from Node, so requesting `nodejs_compat` would defeat
// the test: it would prove the core runs in workerd WITH a Node shim, which is
// not what the README promises. If a `node:` import ever creeps in, this
// should fail rather than quietly compensate.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/workerd-smoke.worker.ts",
      miniflare: {
        compatibilityDate: "2026-03-01",
      },
    }),
  ],
  test: {
    include: ["test-workerd/**/*.test.ts"],
  },
});
