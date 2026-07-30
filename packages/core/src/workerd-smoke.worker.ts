/**
 * Trivial worker entry — `@cloudflare/vitest-pool-workers`' `main` option
 * requires SOME worker module to exist, even though this package is a library
 * with no HTTP surface of its own.
 *
 * The actual portability proof is in `test-workerd/portability.test.ts`, which
 * imports this package's exports inside the simulated workerd runtime that
 * this file's presence unlocks.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("depgraph-core workerd smoke worker — not an endpoint");
  },
};
