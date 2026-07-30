/**
 * Extractors — one per machine-readable manifest format.
 *
 * Each extractor turns one file into normalized *facts*. Facts are the only
 * thing that reaches the lock; raw file contents never do. That keeps the lock
 * reviewable, and it means the derivation stage (derive.ts) is a pure
 * function of data a human can read in a diff.
 *
 * An extractor states what a file DECLARES. It does not decide what that means
 * for the graph — resolution of a name to a repository is derive.ts's job,
 * and it happens against an index discovered from the repositories themselves.
 */

import { parse as parseToml } from "smol-toml";

import type {
  CargoFacts,
  ClusterLockFacts,
  ClusterTomlFacts,
  GoModFacts,
  NpmFacts,
  ServerJsonFacts,
  TaskfileFacts,
  VersionPinFacts,
  WorkflowFacts,
} from "./sources-lock.js";

/** A parsed TOML document, before we have decided what any of it means. */
type Toml = Record<string, any>;

/** Best-effort line number for `key` at the start of a line. Null if ambiguous. */
function lineOf(text: string, key: string): number | null {
  const pattern = new RegExp(
    `^\\s*(?:"${escapeRe(key)}"|${escapeRe(key)})\\s*=`,
    "m",
  );
  const match = pattern.exec(text);
  if (!match) return null;
  const before = text.slice(0, match.index);
  const first = before.split("\n").length;
  // Only report a line when the key appears exactly once, so provenance is
  // never confidently wrong.
  const all = new RegExp(pattern.source, "gm");
  let count = 0;
  while (all.exec(text)) count += 1;
  return count === 1 ? first : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CARGO_DEP_TABLES = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
];

function cargoDepsFrom(
  table: unknown,
  tableName: string,
  text: string,
  out: CargoFacts["deps"],
): void {
  if (!table || typeof table !== "object") return;
  for (const [name, spec] of Object.entries(table as Record<string, any>)) {
    const record: CargoFacts["deps"][number] = {
      name,
      table: tableName,
      package: null,
      version: null,
      git: null,
      rev: null,
      tag: null,
      branch: null,
      path: null,
      line: lineOf(text, name),
    };
    if (typeof spec === "string") {
      record.version = spec;
    } else if (spec && typeof spec === "object") {
      record.package = spec.package ?? null;
      // `version` and `git`+`rev` routinely coexist: cargo-deny's wildcards
      // rule requires a version alongside a git dependency. Both are real and
      // both are kept — a git dependency carries two version facts, and
      // flattening them to one loses the distinction between the resolved
      // semver and the exact commit that is actually built.
      record.version = spec.version ?? null;
      record.git = spec.git ?? null;
      record.rev = spec.rev ?? null;
      record.tag = spec.tag ?? null;
      record.branch = spec.branch ?? null;
      record.path = spec.path ?? null;
    }
    out.push(record);
  }
}

/** Cargo.toml — package identity, workspace members, and every dependency table. */
export function extractCargo(text: string): CargoFacts {
  const doc = parseToml(text) as Toml;
  const deps: CargoFacts["deps"] = [];

  for (const tableName of CARGO_DEP_TABLES) {
    cargoDepsFrom(doc[tableName], tableName, text, deps);
  }
  if (doc.workspace) {
    for (const tableName of CARGO_DEP_TABLES) {
      cargoDepsFrom(
        doc.workspace[tableName],
        `workspace.${tableName}`,
        text,
        deps,
      );
    }
  }
  // Platform-gated dependency tables are ordinary dependencies with a cfg
  // predicate. cloister's leyline-sign host build lives only here, so an
  // extractor that skipped them would miss a real edge.
  for (const [cfg, section] of Object.entries<any>(doc.target ?? {})) {
    for (const tableName of CARGO_DEP_TABLES) {
      cargoDepsFrom(
        section?.[tableName],
        `target.${cfg}.${tableName}`,
        text,
        deps,
      );
    }
  }

  const publishes = [];
  if (doc.package?.name) publishes.push(doc.package.name);

  return {
    package: doc.package?.name
      ? {
          name: doc.package.name,
          version:
            typeof doc.package.version === "string"
              ? doc.package.version
              : null,
        }
      : null,
    publishes,
    workspaceMembers: Array.isArray(doc.workspace?.members)
      ? [...doc.workspace.members].sort()
      : [],
    deps: deps.sort(sortByNameTable),
  };
}

function sortByNameTable(
  a: { name: string; table: string },
  b: { name: string; table: string },
): number {
  return a.name < b.name
    ? -1
    : a.name > b.name
      ? 1
      : a.table < b.table
        ? -1
        : a.table > b.table
          ? 1
          : 0;
}

const GOMOD_MODULE = /^module\s+(\S+)/m;

/**
 * A `replace` right-hand side is a filesystem path rather than a module path
 * exactly when it starts with `./`, `../`, or is absolute — the rule the go
 * command itself uses. Everything else is a module path, and a module-for-module
 * replacement still resolves from the proxy.
 */
function isLocalReplacement(target: string): boolean {
  return (
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(target)
  );
}

/** One `replace` body, with or without versions: `old [v] => new [v]`. */
function parseReplace(
  body: string,
  line: number,
): GoModFacts["replaces"][number] | null {
  const halves = body.split("=>");
  if (halves.length !== 2) return null;
  const left = halves[0].trim().split(/\s+/).filter(Boolean);
  const right = halves[1].trim().split(/\s+/).filter(Boolean);
  if (left.length === 0 || right.length === 0) return null;
  return {
    path: left[0],
    version: left[1] ?? null,
    with: right[0],
    withVersion: right[1] ?? null,
    local: isLocalReplacement(right[0]),
    line,
  };
}

/**
 * go.mod — the module path it declares, its direct requirements, and its
 * `replace` directives.
 *
 * Both `require` and `replace` support the same two spellings (a single line,
 * or a parenthesised block), so one scanner handles both and tracks which
 * directive opened the block it is inside.
 */
export function extractGoMod(text: string): GoModFacts {
  const moduleMatch = GOMOD_MODULE.exec(text);
  const requires: GoModFacts["requires"] = [];
  const replaces: GoModFacts["replaces"] = [];
  const lines = text.split("\n");
  // `exclude` and `retract` open blocks too. They are tracked rather than
  // skipped, because the `)` bookkeeping is shared — an untracked block would
  // leave its closing paren to be read as the end of some other directive.
  let block: "require" | "replace" | "ignored" | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    const opened = /^(require|replace|exclude|retract)\s*\($/.exec(trimmed);
    if (!block && opened) {
      const directive = opened[1];
      block =
        directive === "require" || directive === "replace"
          ? directive
          : "ignored";
      continue;
    }
    if (block && trimmed === ")") {
      block = null;
      continue;
    }

    // Strip a trailing line comment before parsing, but keep the raw line for
    // the `// indirect` marker, which is a comment with meaning.
    const withoutComment = trimmed.replace(/\/\/.*$/, "").trim();

    if (block === "replace" || (!block && /^replace\s/.test(trimmed))) {
      const body = block
        ? withoutComment
        : /^replace\s+(.+)$/.exec(withoutComment)?.[1];
      if (!body) continue;
      const parsed = parseReplace(body, i + 1);
      if (parsed) replaces.push(parsed);
      continue;
    }

    if (block === "require" || (!block && /^require\s/.test(trimmed))) {
      const body = block
        ? withoutComment
        : /^require\s+(.+)$/.exec(withoutComment)?.[1];
      if (!body) continue;
      const parts = body.split(/\s+/);
      if (parts.length < 2) continue;
      requires.push({
        path: parts[0],
        version: parts[1],
        indirect: /\/\/\s*indirect/.test(line),
        line: i + 1,
      });
    }
  }

  return {
    module: moduleMatch ? moduleMatch[1] : null,
    publishes: moduleMatch ? [moduleMatch[1]] : [],
    requires: requires.sort((a, b) => (a.path < b.path ? -1 : 1)),
    replaces: replaces.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

const NPM_DEP_TABLES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** package.json — the package it publishes and every dependency table. */
export function extractNpm(text: string): NpmFacts {
  const doc = JSON.parse(text) as Record<string, any>;
  const deps: NpmFacts["deps"] = [];
  for (const tableName of NPM_DEP_TABLES) {
    for (const [name, spec] of Object.entries(doc[tableName] ?? {})) {
      deps.push({
        name,
        table: tableName,
        spec: typeof spec === "string" ? spec : null,
      });
    }
  }
  return {
    name: doc.name ?? null,
    version: doc.version ?? null,
    // A `private: true` package is not published, but it still declares
    // dependencies, and its name still identifies it to a workspace sibling.
    publishes: doc.name ? [doc.name] : [],
    deps: deps.sort(sortByNameTable),
  };
}

const MCP_REQUIRED_DEPS_SUFFIX = "/required-deps";
const CLOISTER_TENANCY_KEY = "art.cloister/v1";

/** server.json — MCP identity, published artifacts, and declared couplings. */
export function extractServerJson(text: string): ServerJsonFacts {
  const doc = JSON.parse(text) as Record<string, any>;
  const meta: Record<string, any> = doc._meta ?? {};

  // A server that declares how it is launched has named its own executable.
  // That turns "a file called .mache-version pins something called mache" from
  // a naming guess into a match against what mache itself publishes.
  const commands: ServerJsonFacts["commands"] = [];
  for (const [key, value] of Object.entries<any>(meta)) {
    if (!key.endsWith("/transports")) continue;
    for (const [transport, spec] of Object.entries(
      (value ?? {}) as Record<string, any>,
    )) {
      if (typeof spec?.command === "string") {
        commands.push({ metaKey: key, transport, command: spec.command });
      }
    }
  }

  const requiredDeps: ServerJsonFacts["requiredDeps"] = [];
  for (const [key, value] of Object.entries<any>(meta)) {
    if (!key.endsWith(MCP_REQUIRED_DEPS_SUFFIX)) continue;
    for (const [server, spec] of Object.entries(
      (value ?? {}) as Record<string, any>,
    )) {
      requiredDeps.push({
        metaKey: key,
        server,
        minimumVersion: spec?.["minimum-version"] ?? null,
        purpose: typeof spec?.purpose === "string" ? spec.purpose : null,
      });
    }
  }

  return {
    name: doc.name ?? null,
    version: doc.version ?? null,
    repositoryUrl: doc.repository?.url ?? null,
    publishes: [
      ...(doc.name ? [doc.name] : []),
      ...(doc.packages ?? [])
        .map((p: any) => p.identifier)
        .filter((id: any): id is string => typeof id === "string"),
    ],
    packages: (doc.packages ?? []).map((p: any) => ({
      registryType: p.registryType ?? null,
      identifier: p.identifier ?? null,
      version: p.version ?? null,
    })),
    remotes: (doc.remotes ?? []).map((r: any) => ({ type: r.type ?? null })),
    commands: commands.sort((a, b) =>
      a.command + a.transport < b.command + b.transport ? -1 : 1,
    ),
    // Declaring `art.cloister/v1` is a statement that this server expects to be
    // mounted as a cloister tenant. That is a coupling to cloister's tenancy
    // contract, authored at the site that knows it.
    declaresCloisterTenancy: Object.hasOwn(meta, CLOISTER_TENANCY_KEY),
    requiredDeps: requiredDeps.sort((a, b) => (a.server < b.server ? -1 : 1)),
  };
}

const CLUSTER_INPUT_REF =
  /^github:\/\/([^/]+)\/([^/]+)\/(.+?)@([0-9a-f]{7,40})$/;

/** cluster.toml — bundles, the wires between them, and pinned inputs. */
export function extractClusterToml(text: string): ClusterTomlFacts {
  const doc = parseToml(text) as Toml;

  const bundles = (doc.bundles ?? []).map((bundle: any) => ({
    name: bundle.name ?? null,
    kind: bundle.kind ?? null,
    tier: bundle.tier ?? null,
    // A bundle's deployable identity lives under `[bundles.external]`. Bundles
    // that run a binary rather than an image name it via `entryPoint` instead,
    // and that path's basename is the same identifying fact.
    image: bundle.external?.image ?? bundle.deployment?.image ?? null,
    entryPoint: bundle.external?.entryPoint ?? null,
    workerdServiceName: bundle.workerdServiceName ?? null,
  }));

  const wires = (doc.wires ?? []).map((wire: any) => ({
    from: wire.from ?? null,
    to: wire.to ?? null,
    binding: wire.binding ?? null,
    transport: wire.transport ?? null,
  }));

  const inputs: ClusterTomlFacts["inputs"] = [];
  for (const [key, value] of Object.entries<any>(doc.inputs ?? {})) {
    const ref = typeof value?.ref === "string" ? value.ref : null;
    const parsed = ref ? CLUSTER_INPUT_REF.exec(ref) : null;
    inputs.push({
      key,
      ref,
      owner: parsed?.[1] ?? null,
      repo: parsed?.[2] ?? null,
      path: parsed?.[3] ?? null,
      rev: parsed?.[4] ?? null,
      version: typeof value?.version === "string" ? value.version : null,
      line: lineOf(text, "ref"),
    });
  }

  return {
    clusterName: doc.metadata?.name ?? null,
    bundles: bundles.sort((a: any, b: any) => (a.name < b.name ? -1 : 1)),
    wires: wires.sort((a: any, b: any) =>
      a.from + a.to < b.from + b.to ? -1 : 1,
    ),
    inputs: inputs.sort((a: { key: string }, b: { key: string }) =>
      a.key < b.key ? -1 : 1,
    ),
  };
}

/**
 * cluster.lock.toml — cloister's resolved input lock.
 *
 * Generated by cloister's own resolver and committed beside cluster.toml, it
 * carries what cluster.toml cannot: the fully-qualified OCI identifier each
 * input resolved to, its version, and its digest. That turns an image
 * reference matched by name into one matched by the identifier the publisher
 * declares — the same fact, established rather than guessed.
 */
export function extractClusterLock(text: string): ClusterLockFacts {
  const doc = parseToml(text) as Toml;
  const inputs: ClusterLockFacts["inputs"] = [];
  for (const [key, value] of Object.entries<any>(doc.inputs ?? {})) {
    const parsed =
      typeof value?.ref === "string" ? CLUSTER_INPUT_REF.exec(value.ref) : null;
    inputs.push({
      key,
      owner: parsed?.[1] ?? null,
      repo: parsed?.[2] ?? null,
      path: parsed?.[3] ?? null,
      rev: parsed?.[4] ?? null,
      resolved: typeof value?.resolved === "string" ? value.resolved : null,
      sha256: typeof value?.sha256 === "string" ? value.sha256 : null,
      oci: value?.oci
        ? {
            identifier: value.oci.identifier ?? null,
            version: value.oci.version ?? null,
            digest: value.oci.digest ?? null,
          }
        : null,
    });
  }
  return {
    schema: doc.schema ?? null,
    cluster: doc.cluster ?? null,
    inputs: inputs.sort((a: { key: string }, b: { key: string }) =>
      a.key < b.key ? -1 : 1,
    ),
  };
}

const RELEASE_URL =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download/g;

/**
 * Taskfile.yml — release artifacts it downloads, by repository.
 *
 * A literal `github.com/<owner>/<repo>/releases/download` URL names the
 * repository outright, exactly as a git dependency's URL does. It is worth
 * reading because it is the strongest statement a consumer makes about where
 * an executable comes from: canonical-hours pins mache's version in
 * `.mache-version`, but it says WHICH mache here.
 *
 * Deliberately plain-text, not YAML-parsed. A URL is a URL wherever it appears
 * in the file, and matching it needs no parser and no new dependency.
 */
export function extractTaskfile(text: string): TaskfileFacts {
  const repos = new Set<string>();
  for (const match of text.matchAll(RELEASE_URL)) {
    repos.add(`${match[1]}/${match[2]}`);
  }
  return {
    releaseRepos: [...repos].sort().map((coordinate: string) => {
      const [owner, repo] = coordinate.split("/");
      return { owner, repo };
    }),
  };
}

/**
 * A GitHub Actions workflow, read for `repository_dispatch` wiring.
 *
 * Plain-text, not YAML-parsed, for the same reason `extractTaskfile` is: the
 * two things wanted here are a short list under a known key and a shell command
 * with a fixed shape, and neither needs a parser or a new dependency in a repo
 * that has nine.
 *
 * COMMENTED-OUT LINES ARE DROPPED FIRST, and that is load-bearing rather than
 * tidy. `template-go` and `template-rust` both carry a commented `gh api
 * repos/.../dispatches` in their release workflow as an example. A reader
 * grepping for `event_type` finds them and concludes they are producers; they
 * are not, and an extractor that agreed would put two edges on the map that no
 * workflow can ever fire.
 */
const WORKFLOW_DISPATCH_TARGET = /gh\s+api\s+repos\/(\S+?)\/dispatches/;
const WORKFLOW_EVENT_TYPE = /event_type=([A-Za-z0-9._-]+)/;

export function extractWorkflow(text: string): WorkflowFacts {
  // Strip whole-line comments. `#` also opens a comment inside a `run:` shell
  // block, so one rule covers both languages in the file.
  const lines = text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line));

  // ── consumer side: on.repository_dispatch.types ──────────────────────
  const listensFor = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*repository_dispatch:\s*$/.test(lines[i])) continue;
    // `types:` follows within the block, either inline or as a list.
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const inline = /^\s*types:\s*\[(.*)\]\s*$/.exec(lines[j]);
      if (inline) {
        for (const raw of inline[1].split(",")) {
          const name = raw.trim().replace(/^['"]|['"]$/g, "");
          if (name) listensFor.add(name);
        }
        break;
      }
      if (/^\s*types:\s*$/.test(lines[j])) {
        for (let k = j + 1; k < lines.length; k += 1) {
          const item = /^\s*-\s*(.+?)\s*$/.exec(lines[k]);
          if (!item) break;
          listensFor.add(item[1].replace(/^['"]|['"]$/g, ""));
        }
        break;
      }
      // A non-blank line that is not `types:` means the block moved on. An
      // unqualified `repository_dispatch:` accepts every type, which this graph
      // records as listening for nothing in particular rather than everything.
      if (lines[j].trim() && !/^\s*(#|types:)/.test(lines[j])) break;
    }
  }

  // ── producer side: gh api repos/<owner>/<repo>/dispatches ────────────
  const dispatches: WorkflowFacts["dispatches"] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const target = WORKFLOW_DISPATCH_TARGET.exec(lines[i]);
    if (!target) continue;

    // The event type is on the same line or one of the next few — the `gh api`
    // invocation is conventionally split across continuations.
    let event: string | null = null;
    for (let j = i; j < Math.min(i + 6, lines.length); j += 1) {
      const found = WORKFLOW_EVENT_TYPE.exec(lines[j]);
      if (found) {
        event = found[1];
        break;
      }
    }
    if (!event) continue;

    // `repos/${TARGET_REPO}/dispatches` names no repository at read time.
    // Recorded with a null target rather than dropped, so the dispatch is
    // visible and the reason it resolves to nothing is stated.
    const literal = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(target[1]);
    dispatches.push({
      event,
      owner: literal ? literal[1] : null,
      repo: literal ? literal[2] : null,
      line: i + 1,
    });
  }

  return {
    listensFor: [...listensFor].sort(),
    dispatches: dispatches.sort((a, b) =>
      a.event + (a.repo ?? "") < b.event + (b.repo ?? "") ? -1 : 1,
    ),
  };
}

const BARE_VERSION = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * A `.<tool>-version` dotfile — a bare version string pinning an external
 * tool. canonical-hours pins mache this way, and the pin is read by both its
 * Taskfile and its CI workflow. It is not package.json, server.json, or
 * cluster.toml, and a generator that only knew those three formats would miss
 * the edge entirely.
 */
export function extractVersionPin(
  fileName: string,
  text: string,
): VersionPinFacts | null {
  const match = /^\.([a-z0-9][a-z0-9-]*)-version$/.exec(fileName);
  if (!match) return null;
  const version = text.trim();
  if (!BARE_VERSION.test(version)) return null;
  return { tool: match[1], version };
}

export const EXTRACTORS = {
  cargo: extractCargo,
  gomod: extractGoMod,
  npm: extractNpm,
  "server-json": extractServerJson,
  "cluster-toml": extractClusterToml,
};
