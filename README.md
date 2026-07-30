# 0day-api

Derive a dependency map from what repositories already declare, and serve it
as data.

This is the reusable half of [〇.day](https://xn--w6j.day), extracted so it can
run against any set of repositories rather than one. The map it produces is
regenerated from its sources and gated on being exactly their derivation — a
hand-edited graph cannot survive review, because the gate re-derives and
compares byte-for-byte.

## Packages

| Package | What it is |
| --- | --- |
| [`@agentic-research/depgraph-core`](packages/core) | The contract, the derivation and the gate. `zod` and `smol-toml` only — no filesystem, no network. Runs in workerd or a browser. |
| [`@agentic-research/depgraph-collect`](packages/collect) | Reading repositories into a sources lock. Node-only, and uses no credential. |

The split is not stylistic. The design rests on one gate — *re-derive from the
same sources and compare* — and that only means something if deriving cannot
reach the network. Otherwise "the artifact matches its sources" quietly becomes
"the artifact matches whatever the network returned this time".

## What it produces

A document that splits **authored** statements from **derived** facts, and
records how confident each coupling is:

- `edges` — the source named the repository outright, or named an identifier
  that repository declares publishing.
- `weak_edges` — the target could only be matched by name. Kept, because
  deleting a real coupling is its own distortion, but never folded into
  `edges`.
- `unresolved` — parsed, resolved to nothing, with the reason.

## What it does not do, stated plainly

`unresolved` records **resolution** gaps. A coupling declared in a format the
collector has no parser for is never attempted, so it is **absent rather than
recorded**. The formats read today are: `Cargo.toml`, `go.mod`,
`package.json` (recursively), `server.json`, `cluster.toml`,
`cluster.lock.toml`, `Taskfile.yml`, `.<tool>-version` pins (root only), and
`.github/workflows/*.yml`.

Anything else is unexamined, not empty. A tool that declares its wiring in its
own config file is invisible here, and the map cannot currently tell you that
it looked. Closing that — recording seen-but-unparsed declarations as a
first-class finding — is tracked as `0day-11da43`.

No credential is used anywhere. Repository visibility is established by asking
GitHub unauthenticated, and it fails closed: a repository whose visibility
cannot be established is treated as private, its manifests are never read, and
any edge touching it carries no detail. This is why adding a token would be a
regression rather than a feature — a privileged collector records private
repositories as public, which is a real bug this code already had once.

## Status

The pipeline half is here and proven: running `depgraph-core`'s `derive`
against 〇.day's committed sources reproduces its published artifact
byte-for-byte.

The serving half — an HTTP MCP endpoint, content-negotiated `/`, and gated
access — is designed but not yet built, and neither package is published to
npm yet, so the names above are proposals until they are.

## License

Apache-2.0
