/**
 * Derive — turn collected declarations into the dependency graph.
 *
 * This module is a PURE function of the lock. It reads no files, calls no
 * network, and consults no clock. That is what makes the CI gate meaningful:
 * `task deps:check` re-runs this over the committed lock and fails if the
 * committed graph is not exactly what comes out.
 *
 * Two passes:
 *
 *   1. Ownership. Every repository is asked what it publishes — crate names, Go
 *      module paths, npm package names, OCI identifiers, MCP server names. That
 *      index is discovered, never authored, so no hand-written name→repo table
 *      exists to fall out of date.
 *   2. Resolution. Every declared dependency is looked up in that index. What
 *      resolves becomes an edge. What does not resolve becomes an entry in
 *      `unresolved`, with the reason — the graph reports its own coverage gaps
 *      rather than quietly shrinking.
 */

import {
  SiteMap,
  schemaUrl,
  SCHEMA_VERSION,
  // The coupling vocabulary lives in the contract, not here. It used to be
  // declared in both places with nothing keeping them equal.
  EDGE_KINDS,
  RESERVED_EDGE_KINDS,
} from "./site-map.js";
import type { SourcesLock } from "./sources-lock.js";

type SiteMapDoc = import("zod").infer<typeof SiteMap>;
type Edge = SiteMapDoc["edges"][number];
type Entity = SiteMapDoc["entities"][number];
type Unresolved = SiteMapDoc["unresolved"][number];

/** An authored project record, as `projects.ts` exports it. */
type Project = {
  slug: string;
  name: string;
  domain: string;
  status: string;
  visibility: string;
  question: string;
  primitive: string;
  description: string;
  relationships: { project: string; verb: string }[];
  links: { label: string; href: string }[];
};

/** Who publishes a given name, and by which rule we know it. */
type Owner = {
  repo: string;
  method: string;
  where?: string;
  /** The key this owner is indexed under, so an edge can cite what it matched. */
  coordinate?: string;
};
/** One publish claim, before collisions have been counted. */
type Declaration = {
  coordinate: string;
  kind: string;
  repo: string;
  where: string | null;
};
type OwnershipIndex = {
  crate: Map<string, Owner>;
  goModule: Map<string, Owner>;
  npm: Map<string, Owner>;
  oci: Map<string, Owner>;
  mcp: Map<string, Owner>;
  command: Map<string, Owner>;
  binary: Map<string, Owner>;
  /** Every claim that entered the index, collisions included. */
  declarations: Declaration[];
  /** Claims refused as not-a-name, so the refusal is visible rather than silent. */
  rejected: Declaration[];
};

export const GRAPH_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * How an edge's target was resolved, and how much that resolution is worth.
 *
 * `exact` means the source named the repository, or named an identifier the
 * target repository itself declares publishing. `by-name` means a name was
 * matched against a naming convention — true today, and able to become quietly
 * wrong if something is renamed.
 *
 * This is recorded per edge because the difference matters to anyone reading
 * the graph, and stating it in prose somewhere would make it exactly the kind
 * of claim that rots. A consumer can filter on it; a reviewer can count it.
 */
export const RESOLUTION = {
  "git-url": {
    confidence: "exact",
    how: "the dependency's git URL is the repository coordinate",
  },
  "github-ref": {
    confidence: "exact",
    how: "a github://owner/repo@sha reference",
  },
  "dispatch-target": {
    confidence: "exact",
    how: "a workflow names the repository it dispatches to outright, and that repository's own workflow declares accepting the event — both halves of the coupling are declared, which is why this is exact rather than a name match",
  },
  "go-module-path": {
    confidence: "exact",
    how: "a Go module path, which is a repository coordinate by the language spec",
  },
  "crate-name": {
    confidence: "exact",
    how: "matches a crate name the target declares in [package].name",
  },
  "npm-package-name": {
    confidence: "exact",
    how: "matches a package name the target declares in package.json",
  },
  "mcp-server-name": {
    confidence: "exact",
    how: "matches an MCP server name the target declares in server.json",
  },
  "declared-command": {
    confidence: "exact",
    how: "matches the executable name the target declares launching itself with",
  },
  "oci-identifier": {
    confidence: "exact",
    how: "matches, in full, an OCI identifier the target declares publishing",
  },
  "oci-repository": {
    confidence: "exact",
    how: "matches the registry repository path the target declares publishing, with the tag ignored — the tag names a version, not a repository, so the path alone identifies the publisher",
  },
  "release-url": {
    confidence: "exact",
    how: "a literal github.com/<owner>/<repo>/releases/download URL — the repository named outright, exactly as a git dependency's URL names one",
  },
  "version-pin-filename": {
    confidence: "by-name",
    how: "a `.<tool>-version` filename, where the tool name comes from the FILENAME rather than from anything the target declares",
  },
  "meta-key": {
    confidence: "convention",
    how: "a namespaced _meta key whose owner is identified by a constant in this generator",
  },
  "repo-slug": {
    confidence: "by-name",
    how: "a tool or bundle name matched to a repository slug",
  },
  "mcp-name-tail": {
    confidence: "by-name",
    how: "the last segment of an MCP server name treated as a binary name",
  },
  "image-name": {
    confidence: "by-name",
    how: "an image reference stripped to its bare name and matched to a repository",
  },
  "entrypoint-basename": {
    confidence: "by-name",
    how: "the basename of an executable path matched to a repository",
  },
  "inherited-bundle": {
    confidence: "by-name",
    how: "inherits however the bundle at the other end of the wire resolved",
  },
};

const GITHUB_HOST_PATH =
  /^(?:https?:\/\/|git\+https:\/\/|ssh:\/\/git@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/.]+)/;

/**
 * Resolve an OCI reference, reporting HOW it matched.
 *
 * A full-identifier match is one string equalling another. A tag-stripped match
 * compares registry repository paths whose versions differ — still exact, since
 * a tag names a version rather than a repository, but it is a different claim
 * and a consumer deserves to see which one happened.
 */
function resolveOci(
  index: OwnershipIndex,
  reference: string | null | undefined,
): Owner | null {
  if (!reference) return null;
  const full = index.oci.get(reference);
  if (full) return { ...full, method: "oci-identifier" };
  const untagged = stripTag(reference);
  if (!untagged || untagged === reference) return null;
  const byPath = index.oci.get(untagged);
  if (!byPath) return null;

  // Only a REGISTRY-QUALIFIED path earns the exact reading. `ghcr.io/o/r:1.2`
  // stripped to `ghcr.io/o/r` still names a repository; `rosary:0.7.0`
  // stripped to `rosary` names nothing but a word that happens to match. The
  // first is path identity, the second is a naming convention, and collapsing
  // them would promote a name match to a fact — so a bare form keeps whatever
  // rule its index entry was built under.
  const registryQualified =
    untagged.includes("/") && byPath.method === "oci-identifier";
  return registryQualified ? { ...byPath, method: "oci-repository" } : byPath;
}

/** Drop a `:tag` suffix from an OCI reference, keeping any registry port. */
function stripTag(identifier: unknown): string | null {
  if (typeof identifier !== "string") return null;
  const slash = identifier.lastIndexOf("/");
  const colon = identifier.lastIndexOf(":");
  return colon > slash ? identifier.slice(0, colon) : identifier;
}

/** Normalize a git URL to `owner/repo`, or null. */
function githubCoordinate(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = GITHUB_HOST_PATH.exec(url.replace(/\.git$/, ""));
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Is this coordinate a real name, or an artefact of an unrendered template?
 *
 * `template-go/go.mod` declares `module github.com/agentic-research/{{project-name}}`
 * — a scaffold nobody substituted. The go command REFUSES that file outright,
 * but a regex reading `^module (\S+)` accepts it happily, and it would then
 * enter the published index as a name this ecosystem claims to publish.
 *
 * The check is deliberately narrow: characters no coordinate in any of these
 * naming systems can contain. It is not a validator for module paths, crate
 * names or OCI references — inventing one would be its own source of wrong
 * answers. It rejects what is obviously not a name at all.
 */
const TEMPLATE_OR_INVALID = /[{}<>\s]|\$\{/;

/**
 * Build the ownership index from the lock's own facts.
 *
 * The index answers "who publishes this coordinate" during resolution, and
 * `declarations` records every claim that went into it — including the ones a
 * map would have dropped when two repositories claim the same name. Both come
 * from the same `claim()` call so they cannot drift apart, which would be a
 * poor joke in this particular repository.
 */
export function buildOwnership(lock: SourcesLock): OwnershipIndex {
  const index: OwnershipIndex = {
    crate: new Map(),
    goModule: new Map(),
    npm: new Map(),
    oci: new Map(),
    mcp: new Map(),
    command: new Map(),
    binary: new Map(),
    declarations: [],
    rejected: [],
  };

  const byGithub = new Map(lock.repos.map((r) => [r.github, r.slug]));

  /**
   * Record one publish claim and index it.
   *
   * `firstWins` matches the guards the call sites used before this helper
   * existed: some coordinates keep the first declaration seen, others the last.
   * Whichever the map keeps, `declarations` keeps them all.
   */
  const claim = (
    map: Map<string, Owner>,
    coordinate: string,
    owner: Owner,
    { firstWins = false } = {},
  ): void => {
    if (TEMPLATE_OR_INVALID.test(coordinate)) {
      index.rejected.push({
        coordinate,
        kind: owner.method,
        repo: owner.repo,
        where: owner.where ?? null,
      });
      return;
    }
    index.declarations.push({
      coordinate,
      kind: owner.method,
      repo: owner.repo,
      where: owner.where ?? null,
    });
    if (firstWins && map.has(coordinate)) return;
    // The owner remembers its own key, so an edge resolved through it can cite
    // the coordinate a reader must look up to reproduce the answer.
    map.set(coordinate, { ...owner, coordinate });
  };

  for (const repo of lock.repos) {
    // A repository always answers to its own slug as a tool name. That is not a
    // naming convention being assumed — the slug is the roster key, derived
    // from the repository coordinate the manifest already names.
    claim(index.binary, repo.slug, { repo: repo.slug, method: "repo-slug" });
  }

  for (const source of lock.sources) {
    const { repo, path: file, format, facts } = source;
    switch (format) {
      case "cargo":
        for (const name of facts.publishes ?? []) {
          claim(index.crate, name, { repo, method: "crate-name", where: file });
        }
        break;
      case "gomod":
        if (facts.module) {
          claim(index.goModule, facts.module, {
            repo,
            method: "go-module-path",
            where: file,
          });
        }
        break;
      case "npm":
        for (const name of facts.publishes ?? []) {
          claim(index.npm, name, {
            repo,
            method: "npm-package-name",
            where: file,
          });
        }
        break;
      case "server-json": {
        if (facts.name) {
          claim(index.mcp, facts.name, {
            repo,
            method: "mcp-server-name",
            where: file,
          });
          // `io.github.agentic-research/mache` → the binary is `mache`.
          const tail = facts.name.split("/").pop();
          if (tail) {
            claim(
              index.binary,
              tail,
              { repo, method: "mcp-name-tail", where: file },
              { firstWins: true },
            );
          }
        }
        for (const declared of facts.commands ?? []) {
          claim(
            index.command,
            declared.command,
            {
              repo,
              method: "declared-command",
              where: `${file} ${declared.metaKey}`,
            },
            { firstWins: true },
          );
        }
        for (const pkg of facts.packages ?? []) {
          if (!pkg.identifier) continue;
          // `ghcr.io/agentic-research/mache:0.19.0` → both the full identifier
          // and its bare image name identify the publisher.
          const bare = pkg.identifier.split("/").pop()?.split(":")[0];
          // Indexed under both the declared form and its untagged form. Which
          // RULE a match reports is decided at lookup, not here: the index
          // records who publishes what, and only the lookup knows whether the
          // consumer's reference matched in full or needed its tag dropped.
          claim(
            index.oci,
            pkg.identifier,
            { repo, method: "oci-identifier", where: file },
            { firstWins: true },
          );
          const untagged = stripTag(pkg.identifier);
          if (untagged) {
            claim(
              index.oci,
              untagged,
              { repo, method: "oci-identifier", where: file },
              { firstWins: true },
            );
          }
          if (bare) {
            claim(
              index.oci,
              bare,
              { repo, method: "image-name", where: file },
              { firstWins: true },
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Go module paths under github.com are repository coordinates by the language
  // spec, so they resolve without an index entry. Seed the roster's coordinates
  // so nested modules (`.../clients/go/leyline-schema`) resolve by prefix.
  for (const [github, slug] of byGithub) {
    claim(
      index.goModule,
      `github.com/${github}`,
      {
        repo: slug,
        method: "go-module-path",
        where: "roster repository coordinate",
      },
      { firstWins: true },
    );
  }

  return index;
}

/**
 * Fold raw claims into the published record, marking every member of a
 * collision rather than picking one. Two repositories declaring the same
 * coordinate is a fact about the ecosystem; deciding which is "right" would be
 * the authored judgment this graph refuses to make.
 *
 * `venturi` and `venturi-fork` both declare `module github.com/agentic-research/venturi`
 * — the live instance, though neither is a roster repository today.
 */
function foldOwnership(declarations: Declaration[]): SiteMapDoc["ownership"] {
  const seen = new Map<string, number>();
  for (const d of declarations) {
    const key = `${d.kind} ${d.coordinate}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const deduped = new Map<string, SiteMapDoc["ownership"][number]>();
  for (const d of declarations) {
    // A repository can declare the same coordinate from the same file more than
    // once (an OCI identifier and its untagged form collapse to one entry).
    // That is not a collision — two DIFFERENT declarers are.
    const identity = `${d.kind} ${d.coordinate} ${d.repo} ${d.where ?? ""}`;
    if (deduped.has(identity)) continue;
    deduped.set(identity, {
      ...d,
      contested: false,
    });
  }
  const entries = [...deduped.values()];
  const declarers = new Map<string, Set<string>>();
  for (const e of entries) {
    const key = `${e.kind} ${e.coordinate}`;
    if (!declarers.has(key)) declarers.set(key, new Set());
    declarers.get(key)!.add(e.repo);
  }
  for (const e of entries) {
    e.contested = (declarers.get(`${e.kind} ${e.coordinate}`)?.size ?? 0) > 1;
  }
  return entries.sort((a, b) =>
    a.coordinate !== b.coordinate
      ? a.coordinate < b.coordinate
        ? -1
        : 1
      : a.kind !== b.kind
        ? a.kind < b.kind
          ? -1
          : 1
        : a.repo < b.repo
          ? -1
          : 1,
  );
}

/**
 * True when `coordinate` names an owner the roster covers. Used to tell a gap
 * in this graph ("we depend on a sibling repository nothing resolved") apart
 * from an ordinary outside dependency, which is not this graph's business.
 */
function isRosterOwner(coordinate: string | null, lock: SourcesLock): boolean {
  if (!coordinate) return false;
  const owner = coordinate.split("/")[0];
  return lock.repos.some((r) => r.github.split("/")[0] === owner);
}

/** Longest-prefix resolution for Go module paths. */
function resolveGoModule(
  index: OwnershipIndex,
  modulePath: string,
): Owner | null {
  let best: Owner | null = null;
  let bestLength = -1;
  for (const [declared, owner] of index.goModule) {
    if (modulePath === declared || modulePath.startsWith(declared + "/")) {
      if (declared.length > bestLength) {
        best = owner;
        bestLength = declared.length;
      }
    }
  }
  return best;
}

/**
 * Normalize a POSIX-ish relative path without touching the filesystem.
 * Returns a path that may begin with `../`, which is the signal we care about.
 */
function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Does an override target land inside the declaring repository, or outside it?
 *
 * `target` is interpreted relative to the directory holding the manifest, which
 * is how every one of these formats defines it. Escaping the repository root is
 * the interesting case: it means the edge resolves from a sibling checkout and
 * nothing published backs it.
 */
function classifyLocalTarget(
  manifestPath: string,
  target: string,
): "path-in-repo" | "path-outside-repo" {
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) {
    // An absolute path is outside by construction — it does not even claim to
    // be relative to this repository.
    return "path-outside-repo";
  }
  const dir = manifestPath.includes("/")
    ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
    : "";
  const joined = normalizeRel(dir ? `${dir}/${target}` : target);
  return joined.startsWith("..") ? "path-outside-repo" : "path-in-repo";
}

/**
 * npm expresses local overrides in the dependency SPEC rather than in a
 * separate directive: `file:`, `link:`, `workspace:`, or a bare relative path.
 * Returns the target when the spec is an override, else null.
 */
function npmLocalTarget(spec: string | null): string | null {
  if (!spec) return null;
  for (const proto of ["file:", "link:", "portal:"]) {
    if (spec.startsWith(proto)) return spec.slice(proto.length);
  }
  // `workspace:` names a sibling package in the same workspace, which is
  // in-repo by definition but carries no path to resolve.
  if (spec.startsWith("workspace:")) return ".";
  if (spec.startsWith("./") || spec.startsWith("../")) return spec;
  return null;
}

/**
 * Coordinate kinds that have no local-override concept at all: an OCI digest, a
 * `github://<repo>/<file>@<sha>` pin, a release asset URL, an MCP server name, a
 * version-pin file. No syntax in these formats can point at a sibling checkout,
 * so `published` here is a statement about the FORMAT rather than an assumption
 * about the value — which is why they are spread from one named constant
 * instead of each writing the literal.
 *
 * A new format with override syntax must not use this. It should classify, or
 * declare `unknown` until it does.
 */
const REMOTE_ONLY = {
  resolves_from: "published" as const,
  resolves_via: null,
};

function edgeKey(edge: Edge): string {
  return [
    edge.from,
    edge.to,
    edge.kind,
    edge.detail ?? "",
    edge.evidence.path,
  ].join(" ");
}

/**
 * Options that cannot be derived from the sources, because they describe the
 * deployment rather than the ecosystem.
 */
export interface DeriveOptions {
  /**
   * Origin that will serve this artifact, e.g. `https://example.com`.
   *
   * Required, and deliberately not defaulted. It becomes the document's
   * `$schema`, so a default would have every deployment publish an artifact
   * pointing at somebody else's contract — a link that resolves, returns a
   * plausible document, and is wrong. That is precisely the failure this
   * project exists to make impossible, so the caller has to say.
   */
  origin: string;

  /**
   * What this deployment calls itself, and what it describes.
   *
   * Was hard-coded to `{ name: "〇.day", url: "https://xn--w6j.day",
   * describes: "agentic-research" }` — which is correct for the reference
   * deployment and a lie for every other one. Missed on extraction because
   * unlike `$schema` it is not a link anyone resolves, so nothing would have
   * failed; the artifact would simply have claimed to be somebody else's.
   */
  site: {
    /** Display name, e.g. `"acme deps"`. */
    name: string;
    /** Canonical URL of the human-facing site. */
    url: string;
    /** What set of repositories this map covers, e.g. an org name. */
    describes: string;
  };
}

/**
 * Which fact field carries a repository's REQUIREMENTS, per source format.
 *
 * Explicit rather than inferred. A format that declares requirements and is
 * absent from this table contributes zero to the disclosure below — which
 * would understate coverage in exactly the way the disclosure exists to
 * prevent — so the omission has to be visible here rather than implied by a
 * heuristic over field names.
 */
const REQUIREMENT_FIELDS: Record<string, string> = {
  cargo: "deps",
  gomod: "requires",
  npm: "deps",
  "server-json": "requiredDeps",
  "cluster-toml": "inputs",
  "cluster-lock": "inputs",
  taskfile: "releaseRepos",
  workflow: "listensFor",
};

/**
 * How many dependency declarations were PARSED, whether or not they became
 * edges.
 *
 * The map only emits edges between repositories it names. A declaration on
 * anything else — the overwhelming majority, since every repository depends on
 * far more of the world than of its own ecosystem — is read, understood, and
 * then deliberately dropped: it is a third-party dependency, not a coverage
 * gap, and recording each one would bury the couplings this map exists to show.
 *
 * That decision is defensible and was invisible. A reader saw two dozen edges
 * and could reasonably conclude these repositories barely depend on anything.
 * Publishing the count turns "we found 24 couplings" into "we found 24 internal
 * couplings among 658 parsed declarations", which is the same fact without the
 * false modesty.
 *
 * Counted from the lock directly rather than by instrumenting the resolution
 * loop's several drop sites. Two independent paths to the same population: if
 * they ever disagree, that is a finding about the resolver rather than a bug in
 * a counter that was threaded through twenty-nine `continue` statements.
 *
 * `version-pin` contributes one per source — the file IS the declaration, and
 * it has no list to walk.
 */
function countDeclarations(lock: SourcesLock): {
  parsed: number;
  distinct: number;
} {
  let parsed = 0;
  const coordinates = new Set<string>();

  for (const source of lock.sources) {
    if (source.format === "version-pin") {
      parsed += 1;
      const tool = (source.facts as { tool?: string }).tool;
      if (tool) coordinates.add(tool);
      continue;
    }
    const field = REQUIREMENT_FIELDS[source.format];
    if (!field) continue;
    const entries = (source.facts as Record<string, unknown>)[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      parsed += 1;
      const name =
        typeof entry === "string"
          ? entry
          : ((entry as Record<string, unknown>).name ??
            (entry as Record<string, unknown>).server ??
            (entry as Record<string, unknown>).repo ??
            (entry as Record<string, unknown>).identifier ??
            (entry as Record<string, unknown>).event ??
            (entry as Record<string, unknown>).path);
      if (typeof name === "string" && name) coordinates.add(name);
    }
  }
  return { parsed, distinct: coordinates.size };
}

/**
 * Derive the graph.
 *
 * @param lock parsed sources lock
 * @param projects the authored records (membership and editorial judgments)
 * @param options deployment facts the sources cannot supply
 * @returns a document satisfying the published contract
 *
 * Reading the authored manifest keeps this deterministic and offline — the two
 * properties the gate depends on. It stops being a function of the lock alone,
 * which is the price of the artifact carrying both halves.
 */
export function derive(
  lock: SourcesLock,
  projects: Project[] = [],
  options: DeriveOptions,
): SiteMapDoc {
  const index = buildOwnership(lock);
  const repoBySlug = new Map(lock.repos.map((r) => [r.slug, r]));
  const bySourceRepo = new Map();
  for (const source of lock.sources) {
    if (!bySourceRepo.has(source.repo)) bySourceRepo.set(source.repo, []);
    bySourceRepo.get(source.repo).push(source);
  }

  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];

  // `matched` defaults to null so only the call sites that actually consulted
  // the ownership index have to say what they looked up. A site that resolved
  // from a URL has nothing to cite, and writing `matched: null` eleven times
  // would obscure the ones that do.
  const add = (
    edge: Omit<Edge, "matched" | "redacted"> & {
      matched?: string | null;
      redacted?: boolean;
    },
  ): void => {
    if (edge.to === edge.from) return; // a repository does not depend on itself
    if (!repoBySlug.has(edge.to)) return;
    // `redacted` is always present on a published edge. Absent-versus-false was
    // a distinction with no meaning, and redaction is what decides how a null
    // `detail` should be read.
    edges.push({
      ...edge,
      matched: edge.matched ?? null,
      redacted: edge.redacted ?? false,
    });
  };

  const miss = (record: Unresolved): void => {
    unresolved.push(record);
  };

  for (const source of lock.sources) {
    const { repo, path: file, format, facts } = source;
    const evidence = (extra = {}) => ({ repo, path: file, format, ...extra });

    if (format === "cargo") {
      for (const dep of facts.deps) {
        const name = dep.package ?? dep.name;
        const owner = dep.git
          ? ownerOfGitUrl(dep.git, lock)
          : index.crate.get(name);
        if (!owner) {
          // A git dependency on an outside project is an ordinary third-party
          // dependency, not a gap in this graph. Only an unresolved dependency
          // on an organization the roster covers is a coverage finding.
          if (dep.git && isRosterOwner(githubCoordinate(dep.git), lock)) {
            miss({
              from: repo,
              want: name,
              via: `${file} [${dep.table}]`,
              reason: `git dependency on ${dep.git}, which is not a roster repository`,
            });
          }
          continue;
        }
        add({
          from: repo,
          to: owner.repo,
          kind: "library",
          resolved_by: dep.git ? "git-url" : owner.method,
          matched: dep.git ? null : (owner.coordinate ?? null),
          // Cargo states an override inline as `path = "..."`.
          resolves_from: dep.path
            ? classifyLocalTarget(file, dep.path)
            : "published",
          resolves_via: dep.path ?? null,
          detail: name,
          // A git dependency carries two version facts and both are kept: the
          // semver cargo-deny requires, and the commit actually built.
          version: dep.version ?? null,
          rev: dep.rev ?? dep.tag ?? dep.branch ?? null,
          evidence: evidence({ table: dep.table, line: dep.line ?? null }),
        });
      }
      continue;
    }

    if (format === "gomod") {
      // A module may be replaced with or without a version on the left side.
      // The unversioned form wins when both are present, matching the go
      // command: an unversioned replace applies to every version.
      const replacedBy = new Map<string, (typeof facts.replaces)[number]>();
      for (const r of facts.replaces) {
        const existing = replacedBy.get(r.path);
        if (!existing || (existing.version && !r.version)) {
          replacedBy.set(r.path, r);
        }
      }

      for (const req of facts.requires) {
        if (req.indirect) continue;
        const owner = resolveGoModule(index, req.path);
        if (!owner || owner.repo === repo) continue;
        const replacement = replacedBy.get(req.path);
        add({
          from: repo,
          to: owner.repo,
          kind: "library",
          resolved_by: owner.method,
          matched: owner.coordinate ?? null,
          resolves_from:
            replacement && replacement.local
              ? classifyLocalTarget(file, replacement.with)
              : "published",
          resolves_via: replacement?.local ? replacement.with : null,
          detail: req.path,
          version: req.version,
          rev: null,
          evidence: evidence({ line: req.line }),
        });
      }
      continue;
    }

    if (format === "npm") {
      for (const dep of facts.deps) {
        const owner = index.npm.get(dep.name);
        if (!owner || owner.repo === repo) continue;
        // npm puts the override in the spec itself rather than in a separate
        // directive, so the same field carries both the range and the override.
        const local = npmLocalTarget(dep.spec);
        add({
          from: repo,
          to: owner.repo,
          kind: "library",
          resolved_by: owner.method,
          matched: owner.coordinate ?? null,
          resolves_from: local ? classifyLocalTarget(file, local) : "published",
          resolves_via: local,
          detail: dep.name,
          version: dep.spec,
          rev: null,
          evidence: evidence({ table: dep.table }),
        });
      }
      continue;
    }

    if (format === "server-json") {
      if (facts.declaresCloisterTenancy) {
        const cloister = index.binary.get("cloister");
        if (cloister) {
          add({
            from: repo,
            to: cloister.repo,
            // Distinct from `composition`: pinning another repository's file at
            // a commit and declaring yourself mountable under its hosting
            // contract fail in different ways. A stale pin is a version
            // problem; a changed tenancy contract is an interface problem.
            kind: "tenancy",
            resolved_by: "meta-key",
            matched: cloister.coordinate ?? null,
            ...REMOTE_ONLY,
            detail: 'declares _meta."art.cloister/v1"',
            version: null,
            rev: null,
            evidence: evidence(),
          });
        } else {
          miss({
            from: repo,
            want: "cloister",
            via: `${file} _meta."art.cloister/v1"`,
            reason: "cloister is not in the roster or was not read",
          });
        }
      }
      for (const dep of facts.requiredDeps) {
        const owner = index.mcp.get(dep.server);
        if (!owner) {
          miss({
            from: repo,
            want: dep.server,
            via: `${file} ${dep.metaKey}`,
            reason: "no repository read publishes that MCP server name",
          });
          continue;
        }
        // A required-dep is a running executable the consumer resolves,
        // downloads and verifies — not something it links.
        add({
          from: repo,
          to: owner.repo,
          kind: "artifact",
          resolved_by: owner.method,
          matched: owner.coordinate ?? null,
          ...REMOTE_ONLY,
          detail: dep.server,
          version: dep.minimumVersion,
          rev: null,
          evidence: evidence({ metaKey: dep.metaKey }),
        });
      }
      continue;
    }

    if (format === "version-pin") {
      const owner =
        index.command.get(facts.tool) ??
        index.crate.get(facts.tool) ??
        index.oci.get(facts.tool) ??
        index.binary.get(facts.tool);
      if (!owner) {
        miss({
          from: repo,
          want: facts.tool,
          via: file,
          reason: "version pin names a tool no repository read publishes",
        });
        continue;
      }
      add({
        from: repo,
        to: owner.repo,
        kind: "artifact",
        // The right-hand side may be exact — mache really does declare
        // `command: "mache"` — but the tool name was read off a FILENAME, and
        // the weakest link decides. `.mache-version` meaning "mache" is a
        // convention, however well established. The same coupling is asserted
        // separately wherever a Taskfile names the repository outright.
        resolved_by: "version-pin-filename",
        matched: owner.coordinate ?? null,
        ...REMOTE_ONLY,
        detail: facts.tool,
        version: facts.version,
        rev: null,
        evidence: evidence(),
      });
      continue;
    }

    if (format === "taskfile") {
      for (const target of facts.releaseRepos ?? []) {
        const coordinate = `${target.owner}/${target.repo}`;
        const owner = lock.repos.find((r) => r.github === coordinate);
        if (!owner) {
          if (isRosterOwner(coordinate, lock)) {
            miss({
              from: repo,
              want: coordinate,
              via: `${file} release download URL`,
              reason: "release URL names a repository not in the roster",
            });
          }
          continue;
        }
        add({
          from: repo,
          to: owner.slug,
          kind: "artifact",
          resolved_by: "release-url",
          ...REMOTE_ONLY,
          detail: `${coordinate} releases`,
          version: null,
          rev: null,
          evidence: evidence(),
        });
      }
      continue;
    }

    if (format === "cluster-lock") {
      // cloister's resolver has already done the hard part: each input carries
      // the fully-qualified OCI identifier it resolved to, plus a digest. That
      // is a stronger statement than the bare image name in cluster.toml, and
      // it resolves against what the publisher itself declares rather than
      // against a naming convention.
      for (const input of facts.inputs) {
        if (!input.oci?.identifier) continue;
        const owner = resolveOci(index, input.oci.identifier);
        if (!owner) {
          miss({
            from: repo,
            want: input.oci.identifier,
            via: `${file} [inputs.${input.key}.oci]`,
            reason:
              "no repository read declares publishing that OCI identifier",
          });
          continue;
        }
        add({
          from: repo,
          to: owner.repo,
          kind: "artifact",
          resolved_by: owner.method,
          matched: owner.coordinate ?? null,
          ...REMOTE_ONLY,
          detail: input.oci.identifier,
          version: input.oci.version ?? input.resolved ?? null,
          // The image digest is the exact artifact, and it is a different fact
          // from the commit a source pin names.
          rev: input.oci.digest ?? null,
          evidence: evidence({ input: input.key }),
        });
      }
      continue;
    }

    if (format === "cluster-toml") {
      const bundleToRepo = new Map();
      for (const bundle of facts.bundles) {
        if (!bundle.name) continue;
        const imageName = bundle.image
          ? (bundle.image.split("/").pop() ?? "").split(":")[0]
          : null;
        const entryName = bundle.entryPoint
          ? bundle.entryPoint.split("/").pop()
          : null;
        // Ordered most-established first. A crate the target declares
        // publishing is a real claim of ownership; an image name stripped to
        // its bare form is a convention. `notme-proxy` resolves here, through
        // notme's own proxy/Cargo.toml — the crate index was the table this
        // originally failed to consult, which is why it read as a gap in the
        // ecosystem when it was a gap in this generator.
        const owner =
          resolveOci(index, bundle.image) ??
          (entryName ? index.command.get(entryName) : null) ??
          (imageName ? index.command.get(imageName) : null) ??
          (imageName ? index.crate.get(imageName) : null) ??
          (entryName ? index.crate.get(entryName) : null) ??
          index.crate.get(bundle.name) ??
          (imageName ? index.oci.get(imageName) : null) ??
          (imageName ? index.binary.get(imageName) : null) ??
          (entryName ? index.binary.get(entryName) : null) ??
          index.binary.get(bundle.name);
        if (owner) {
          bundleToRepo.set(bundle.name, owner);
          if (owner.repo !== repo) {
            add({
              from: repo,
              to: owner.repo,
              kind: "artifact",
              resolved_by: owner.method,
              matched: owner.coordinate ?? null,
              ...REMOTE_ONLY,
              detail: bundle.image ?? bundle.entryPoint ?? bundle.name,
              version: bundle.image?.includes(":")
                ? (bundle.image.split(":").pop() ?? null)
                : null,
              rev: null,
              evidence: evidence({ bundle: bundle.name }),
            });
          }
        } else {
          miss({
            from: repo,
            want: bundle.name,
            via: `${file} [[bundles]]`,
            reason: bundle.image
              ? `no repository read declares publishing "${bundle.image}" as an image, crate or tool`
              : "bundle declares no image, and its name matches no declared crate or tool",
          });
        }
      }

      for (const wire of facts.wires) {
        const target = bundleToRepo.get(wire.to);
        const to = target?.repo;
        const from = bundleToRepo.get(wire.from)?.repo ?? repo;
        if (!to) {
          miss({
            from: repo,
            want: wire.to ?? "(unnamed wire target)",
            via: `${file} [[wires]] ${wire.binding ?? ""}`.trim(),
            reason: "wire target bundle does not resolve to a repository",
          });
          continue;
        }
        add({
          from,
          to,
          kind: "protocol",
          // A wire is only as well-resolved as the bundle it points at.
          resolved_by: target.method,
          matched: target.coordinate ?? null,
          ...REMOTE_ONLY,
          detail: `${wire.binding ?? wire.to ?? "?"} over ${wire.transport ?? "unspecified"}`,
          version: null,
          rev: null,
          evidence: evidence({ wire: `${wire.from} -> ${wire.to}` }),
        });
      }

      for (const input of facts.inputs) {
        const coordinate =
          input.owner && input.repo ? `${input.owner}/${input.repo}` : null;
        const owner = coordinate
          ? lock.repos.find((r) => r.github === coordinate)
          : null;
        if (!owner) {
          miss({
            from: repo,
            want: input.ref ?? input.key,
            via: `${file} [inputs.${input.key}]`,
            reason: coordinate
              ? `${coordinate} is not a roster repository`
              : "input ref is not a parseable github:// coordinate",
          });
          continue;
        }
        add({
          from: repo,
          to: owner.slug,
          kind: "composition",
          resolved_by: "github-ref",
          ...REMOTE_ONLY,
          detail: input.path ? `${input.path} (pinned)` : input.key,
          version: input.version,
          rev: input.rev,
          evidence: evidence({ input: input.key }),
        });
      }
      continue;
    }
  }

  function ownerOfGitUrl(url: unknown, lockDoc: SourcesLock): Owner | null {
    const coordinate = githubCoordinate(url);
    if (!coordinate) return null;
    const repoRecord = lockDoc.repos.find((r) => r.github === coordinate);
    // `method` here, not `how`: every other index entry reports the rule under
    // that key, and this one silently used a different one until the type
    // checker put them side by side.
    return repoRecord ? { repo: repoRecord.slug, method: "git-url" } : null;
  }

  // ── Event edges: a join, not a per-manifest reading ─────────────────────
  //
  // Every other edge kind is derivable from ONE manifest — the file names the
  // dependency and the index names the owner. A `repository_dispatch` coupling
  // is split across two repositories on purpose: the producer's workflow says
  // "I send event E to repository R" and the consumer's says "I accept E",
  // and neither half alone is an edge. So this runs after every workflow has
  // been read, and joins on (event, target).
  //
  // The edge points consumer -> producer, matching every other kind here: the
  // party that reacts is the party that depends.
  //
  // NOTHING BELOW CLAIMS AN EVENT HAS EVER FIRED. A workflow file is a
  // declaration; whether the dispatch ever ran is an observation, needs the
  // Actions API, and would be a different bead. The distinction matters here
  // more than usual, because the live instance is a declared edge that has
  // never fired once: ley-line's release workflow has failed on every run it
  // has ever had, so `leyline-release` has been dispatched zero times.
  {
    const listeners = new Map<string, Set<string>>(); // repo -> events accepted
    const dispatchers: {
      from: string;
      event: string;
      target: string | null;
      file: string;
      line: number;
    }[] = [];
    const githubToSlug = new Map(lock.repos.map((r) => [r.github, r.slug]));

    for (const source of lock.sources) {
      if (source.format !== "workflow") continue;
      const facts = source.facts;
      if (facts.listensFor.length > 0) {
        if (!listeners.has(source.repo)) listeners.set(source.repo, new Set());
        for (const e of facts.listensFor) listeners.get(source.repo)!.add(e);
      }
      for (const d of facts.dispatches) {
        dispatchers.push({
          from: source.repo,
          event: d.event,
          target: d.owner && d.repo ? `${d.owner}/${d.repo}` : null,
          file: source.path,
          line: d.line,
        });
      }
    }

    const paired = new Set<string>();
    for (const d of dispatchers) {
      if (!d.target) {
        // `repos/${TARGET_REPO}/dispatches` — a real dispatch to an unknowable
        // repository. Reported, because dropping it would present a workflow
        // that fans out to other repositories as one that does not.
        miss({
          from: d.from,
          want: d.event,
          via: `${d.file}:${d.line}`,
          reason:
            "repository_dispatch target is a variable, so no repository is named at read time",
        });
        continue;
      }
      const targetSlug = githubToSlug.get(d.target);
      if (!targetSlug) continue; // dispatching outside the roster is not this graph's business
      if (listeners.get(targetSlug)?.has(d.event)) {
        paired.add(`${targetSlug} ${d.event}`);
        add({
          from: targetSlug,
          to: d.from,
          kind: "event",
          resolved_by: "dispatch-target",
          matched: d.target,
          ...REMOTE_ONLY,
          detail: d.event,
          version: null,
          rev: null,
          evidence: {
            repo: d.from,
            path: d.file,
            format: "workflow",
            line: d.line,
          },
        });
      } else {
        // The producer sends an event the named repository does not accept.
        // A dangling half is the finding — this is how a renamed event type
        // silently stops a downstream build.
        miss({
          from: d.from,
          want: `${d.event} -> ${d.target}`,
          via: `${d.file}:${d.line}`,
          reason:
            "dispatches an event the target repository's workflows do not declare accepting",
        });
      }
    }

    // And the other dangling half: a repository waiting for an event nobody in
    // the roster sends. Equally invisible, equally a finding.
    for (const [repo, events] of listeners) {
      for (const event of events) {
        if (paired.has(`${repo} ${event}`)) continue;
        miss({
          from: repo,
          want: event,
          via: ".github/workflows",
          reason:
            "accepts a repository_dispatch event no roster repository is declared to send",
        });
      }
    }
  }

  // Deduplicate: the same declaration read twice (a workspace root and a member
  // naming the same crate) is one edge, and the surviving copy keeps the
  // richest version facts.
  const merged = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, edge);
      continue;
    }
    existing.version ??= edge.version;
    existing.rev ??= edge.rev;
  }

  // Redaction protects the PUBLIC artifact from disclosing private detail. A
  // private-inclusive lock is a local artifact whose operator already has that
  // access and asked for it, so redacting there would hide their own data from
  // them while protecting nobody.
  const redactPrivate = !(lock as any).private_inclusive;
  const resolvedEdges = [...merged.values()]
    .map((edge) => (redactPrivate ? redact(edge, repoBySlug) : edge))
    .sort(compareEdges);

  // Only an exact resolution becomes an asserted edge. A name matched against
  // a convention is true today and can go quietly wrong on a rename, and the
  // whole point of deriving this graph is that it does not state things it
  // cannot stand behind. Weak matches are not deleted — deleting them would
  // hide a real coupling — they are separated, so nothing downstream mistakes
  // one for the other.
  const isExact = (edge: Edge): boolean =>
    RESOLUTION[edge.resolved_by as keyof typeof RESOLUTION]?.confidence ===
    "exact";
  const finalEdges = resolvedEdges.filter(isExact);
  const weakEdges = resolvedEdges.filter((edge) => !isExact(edge));

  const manifestCount = new Map<string, number>();
  for (const source of lock.sources) {
    manifestCount.set(source.repo, (manifestCount.get(source.repo) ?? 0) + 1);
  }

  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  const couplings = summarize({
    nodes: lock.repos.map((r) => ({ id: r.slug })),
    edges: finalEdges,
  });

  // A repository that is never read earns a place only by being named. If no
  // public manifest declares a dependency on it, it contributes no edges, no
  // authored record and no manifests — an entry carrying nothing but the fact
  // that it exists. Naming a non-public repository there discloses something
  // for no informational return; naming one a public Cargo.toml already points
  // at discloses nothing new.
  const touched = new Set();
  for (const edge of [...finalEdges, ...weakEdges]) {
    touched.add(edge.from);
    touched.add(edge.to);
  }

  const entities: Entity[] = lock.repos
    .filter(
      (repo) =>
        repo.read || projectBySlug.has(repo.slug) || touched.has(repo.slug),
    )
    .map((repo) => {
      const authored = projectBySlug.get(repo.slug);
      return {
        id: repo.slug,
        kind: (authored ? "project" : "repository") as Entity["kind"],
        repo: repo.github,
        // What GitHub reports, not the manifest's authored `visibility`.
        repo_visibility: repo.visibility,
        sources_read: repo.read,
        manifests_read: manifestCount.get(repo.slug) ?? 0,
        authored: (authored
          ? {
              name: authored.name,
              domain: authored.domain,
              status: authored.status,
              visibility: authored.visibility,
              question: authored.question,
              primitive: authored.primitive,
              description: authored.description,
              relationships: authored.relationships,
            }
          : null) as Entity["authored"],
        derived: (couplings[repo.slug] ?? {
          depends_on: [],
          depended_on_by: [],
        }) as Entity["derived"],
        links: (authored?.links ?? []) as Entity["links"],
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // A coordinate refused entry to the index is a coverage gap, not a non-event.
  // `template-go` declares `module github.com/agentic-research/{{project-name}}`,
  // which the go command itself rejects; publishing an index that silently
  // omitted it would be the absence-without-a-record this graph exists to avoid.
  for (const r of index.rejected) {
    unresolved.push({
      from: r.repo,
      want: r.coordinate,
      via: r.where ?? "(unknown manifest)",
      reason: `declared coordinate is not a name — refused entry to the ownership index (${r.kind})`,
    });
  }

  const unresolvedSorted = unresolved
    .filter(
      (u, i, all) =>
        all.findIndex(
          (o) => o.from === u.from && o.want === u.want && o.via === u.via,
        ) === i,
    )
    .sort((a, b) => (a.from + a.want < b.from + b.want ? -1 : 1));

  const graph = {
    $schema: schemaUrl(options.origin),
    schema_version: SCHEMA_VERSION,
    note: "Generated by `task deps:derive`. Do not edit by hand — `task deps:check` fails when this file is not the derivation of its sources.",
    // Passed through from the lock, never stamped here: `derive` must stay a
    // pure function of the lock or `deps:check` cannot re-derive and compare.
    // This is what lets a consumer tell a fresh artifact from a cached one —
    // the map is a point-in-time reading of moving sources.
    collected_at: lock.collected_at,
    // Declared on the artifact so a consumer can tell a published map from a
    // local private-inclusive one at a glance, without inferring it from what
    // happens to be redacted.
    private_inclusive: lock.private_inclusive ?? false,
    site: options.site,
    // What was read, as against what became an edge. See countDeclarations.
    declarations: countDeclarations(lock),
    boundary: {
      authored: {
        fields: [
          "status",
          "question",
          "primitive",
          "visibility",
          "description",
          "relationships",
        ],
        meaning:
          "Statements a maintainer makes. Do not infer, override, or second-guess them from activity signals such as stars, commit recency, or release cadence.",
      },
      derived: {
        fields: ["depends_on", "depended_on_by"],
        meaning:
          "Read from a machine-readable source. Each carries the file it was read from and how confidently its target resolved.",
      },
    },
    entities,
    edges: finalEdges,
    weak_edges: weakEdges,
    unresolved: unresolvedSorted,
    ownership: foldOwnership(index.declarations),
    edge_kinds: EDGE_KINDS,
    reserved_edge_kinds: RESERVED_EDGE_KINDS,
    resolution: RESOLUTION,
  };

  // The generator cannot emit an artifact that violates its own contract.
  return SiteMap.parse(graph);
}

/**
 * Private endpoints keep their name and coupling kind and lose everything else.
 * Naming that an edge exists is the point of the map; the version, the commit,
 * the file it was read from, and the dependency's own name are contents of a
 * repository that is not public.
 */
function redact(
  edge: Edge,
  repoBySlug: Map<string, SourcesLock["repos"][number]>,
): Edge {
  const fromPublic = repoBySlug.get(edge.from)?.visibility === "public";
  const toPublic = repoBySlug.get(edge.to)?.visibility === "public";
  if (fromPublic && toPublic) return edge;
  // `resolved_by` is kept: it says how the endpoint was identified, which is
  // not a detail ABOUT the private repository — it is a statement about our own
  // derivation, and dropping it would make a redacted edge fail the contract
  // that requires every edge to declare its rule.
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    resolved_by: edge.resolved_by,
    matched: edge.matched,
    // `resolves_from` is kept for the same reason as `resolved_by` — whether an
    // edge rests on something published or on somebody's local filesystem is a
    // property of OUR derivation, and it is exactly the property a reader needs
    // in order to judge the edge. `resolves_via` is dropped: the target is a
    // path on a contributor's disk, which is contents, not derivation.
    resolves_from: edge.resolves_from,
    resolves_via: null,
    detail: null,
    version: null,
    rev: null,
    redacted: true,
    evidence: { repo: edge.evidence.repo, path: null, format: null },
  };
}

function compareEdges(a: Edge, b: Edge): number {
  const keyA = `${a.from} ${a.to} ${a.kind} ${a.detail ?? ""} ${a.evidence.path ?? ""}`;
  const keyB = `${b.from} ${b.to} ${b.kind} ${b.detail ?? ""} ${b.evidence.path ?? ""}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * Collapse the edge list to `depends_on` / `depended_on_by` per node — the
 * shape the manifest and the site consume, and the shape a release contract
 * needs when it must name the consumer each clause serves.
 */
export function summarize(graph: {
  nodes: { id: string }[];
  edges: Edge[];
}): Record<
  string,
  {
    depends_on: { project: string; kinds: string[] }[];
    depended_on_by: { project: string; kinds: string[] }[];
  }
> {
  const out = new Map(
    graph.nodes.map((node) => [
      node.id,
      { depends_on: new Map(), depended_on_by: new Map() },
    ]),
  );
  for (const edge of graph.edges) {
    const from = out.get(edge.from);
    const to = out.get(edge.to);
    if (from) {
      if (!from.depends_on.has(edge.to))
        from.depends_on.set(edge.to, new Set());
      from.depends_on.get(edge.to).add(edge.kind);
    }
    if (to) {
      if (!to.depended_on_by.has(edge.from)) {
        to.depended_on_by.set(edge.from, new Set());
      }
      to.depended_on_by.get(edge.from).add(edge.kind);
    }
  }
  const result: any = {};
  for (const [id, value] of [...out.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    result[id] = {
      depends_on: [...value.depends_on.entries()]
        .map(([project, kinds]) => ({ project, kinds: [...kinds].sort() }))
        .sort((a, b) => (a.project < b.project ? -1 : 1)),
      depended_on_by: [...value.depended_on_by.entries()]
        .map(([project, kinds]) => ({ project, kinds: [...kinds].sort() }))
        .sort((a, b) => (a.project < b.project ? -1 : 1)),
    };
  }
  return result;
}
