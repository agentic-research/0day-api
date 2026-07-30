/**
 * The portable core: the contract, and everything that can be computed from
 * already-fetched bytes.
 *
 * Nothing here touches a filesystem, a network or a process. That is a
 * deliberate boundary rather than an accident of the current code — it is what
 * lets the derivation run in workerd, a Durable Object or a browser, and it is
 * enforced by the fact that this package's only dependencies is `zod`. Reading and
 * PARSING repositories is `@agentic-research/depgraph-collect`,
 * which is Node-only and depends on this.
 *
 * The split matters for a reason specific to this artifact: the derivation is
 * the part that must be reproducible. If deriving needs I/O, then "re-derive
 * from the same sources and compare" — the gate the whole design rests on —
 * depends on the network behaving the same twice. Here it cannot.
 */
export * from "./site-map.js";
export * from "./sources-lock.js";
export * from "./derive.js";
export * from "./check.js";
export * from "./render.js";
