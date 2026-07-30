/**
 * Reading repositories: the Node half.
 *
 * Everything here touches a filesystem, a network or a process, which is why
 * it is not in `@agentic-research/depgraph-core`. The output is a sources lock
 * — a record of what was read and from which bytes — and the core derives the
 * map from that alone.
 *
 * No credential is used anywhere in this package, and that is load-bearing
 * rather than incidental: repository visibility is established by asking
 * GitHub unauthenticated, so a privileged collector cannot record a private
 * repository as public. Adding a token would silently widen what gets read.
 */
export * from "./roster.js";
export * from "./providers.js";
export * from "./collect.js";
export * from "./inspect.js";
