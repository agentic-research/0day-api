/**
 * The dependency-map contract.
 *
 * One Zod definition serves types, runtime validation, the published JSON
 * Schema, the OpenAPI document and the mache topology schema, so there is no
 * second declaration to drift. That property is the whole point: a contract
 * restated anywhere is a contract that will eventually disagree with itself.
 *
 * Deployment-agnostic. The paths below are relative because every deployment
 * serves the same surfaces; only the ORIGIN differs, and that is the caller's
 * to supply via {@link schemaUrl}. The reference deployment is
 * https://xn--w6j.day, which is where this contract was first published.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;

/**
 * Where the contract is served, relative to a deployment's origin.
 *
 * A path rather than a URL: the schema's `$id` must name the deployment that
 * actually serves it, so a consumer resolving `$id` reaches a document that
 * exists. Hard-coding one origin here would have every deployment publish a
 * schema claiming to live somewhere else.
 */
export const SCHEMA_PATH = "/schema/v1/site-map.json";

/**
 * The absolute `$id` for a given deployment.
 *
 * @param origin e.g. `https://example.com` — scheme and host, no trailing path
 */
export function schemaUrl(origin: string): string {
  return new URL(SCHEMA_PATH, origin).toString();
}

/**
 * The surfaces this site publishes.
 *
 * Named once, here, and consumed by both the about page and the tests. A
 * documentation page that retypes its own URLs is the restatement this project
 * exists to remove.
 */
export const PUBLISHED_ENDPOINTS = [
  {
    path: "/.well-known/site-map.json",
    canonical: true,
    what: "The whole artifact: entities with their authored and derived halves, asserted couplings, weak ones, coverage gaps, and the vocabulary needed to read them.",
  },
  {
    path: "/schema/v1/site-map.json",
    canonical: false,
    what: "The contract as JSON Schema, generated from the same definition the generator validates against.",
  },
  {
    path: "/graph.json",
    canonical: false,
    what: "Byte-identical alias of the artifact. It predates the well-known path and is kept so nothing already fetching it breaks.",
  },
  {
    path: "/projects.json",
    canonical: false,
    what: "The public manifest view: authored project records with their derived dependencies folded in.",
  },
  {
    path: "/.well-known/0day.json",
    canonical: false,
    what: "The service descriptor: what this is, when it was collected, which halves are authored versus derived, and where every other surface lives. Small on purpose — an arriving agent needs where to go, not the whole map.",
  },
  {
    path: "/openapi.json",
    canonical: false,
    what: "The HTTP surface as OpenAPI 3.1, generated from this same list and the same Zod contract. What paths exist and what they return, for a consumer that has not read the site.",
  },
  {
    path: "/schema/v1/mache-topology.json",
    canonical: false,
    what: "A mache topology schema for this artifact, generated from the same Zod definition — mount the map as a navigable tree instead of parsing it. Published beside the data so a consumer gets both the facts and a way to walk them.",
  },
  {
    path: "/projects/<slug>.json",
    canonical: false,
    what: "One entity on its own, carrying the resolution rules its edges cite and the coordinates it publishes — enough to read and reproduce every claim in it without fetching the whole artifact. Granularity stops here; there is no per-edge endpoint.",
  },
];

const Site = z
  .object({
    name: z.string().min(1),
    url: z.url(),
    describes: z.string().min(1),
  })
  .strict();

const BoundarySide = z
  .object({
    fields: z.array(z.string().min(1)),
    meaning: z.string(),
  })
  .strict();

const Boundary = z
  .object({ authored: BoundarySide, derived: BoundarySide })
  .strict();

/**
 * The coupling vocabulary — names AND their meanings, in one declaration.
 *
 * A single repository pair can be coupled several ways at once, and the ways
 * fail differently. mache depends on ley-line-open as a Go library, as a
 * downloaded and digest-verified executable, and as a wire protocol; a scalar
 * `depends_on` flattens all three into one word and loses the fact that they
 * break independently.
 *
 * This used to be TWO declarations: the names here, and the descriptions in
 * the generator, with nothing connecting them. They agreed, but only by
 * inspection — adding a kind in one place and forgetting the other would have
 * produced either a valid kind the document could not describe, or a
 * description for a kind the schema rejects. Neither would have failed a gate.
 *
 * Deriving {@link EDGE_KIND_VALUES} from these keys makes that unrepresentable
 * rather than merely unlikely, which is the standard this project holds
 * everything else to.
 */
export const EDGE_KINDS = {
  library: "linked or imported at build time from a declared dependency",
  artifact: "a pinned executable or image consumed at run time",
  protocol: "an RPC or wire coupling between running processes",
  composition: "a published file of the target, pinned at an exact commit",
  tenancy: "declares itself mountable under the target's hosting contract",
  // Distinct from `protocol`, which is two running processes talking. An event
  // edge is a CI trigger: the target's workflow dispatches a named event and
  // this repository's workflow declares it accepts it. Nothing is running, no
  // wire is open, and the coupling breaks in its own way — a renamed event type
  // silently stops a downstream build without failing anything.
  event: "reacts to a repository_dispatch event the target sends",
} as const;

/**
 * Couplings that are real, named, and deliberately NOT derived.
 *
 * `schema` and `lineage` are the two a handshake cannot fix — a stored `.db`
 * outlives the connection that produced it. No machine-readable source
 * declares them today, and emitting them anyway would mean hand-authoring a
 * fact, which is the failure this generator exists to prevent. They become
 * derivable when a producer declares them; until then their absence is honest.
 *
 * Published in the artifact so a consumer learns the vocabulary BEFORE any
 * edge uses it — which is what makes widening an announcement rather than a
 * surprise.
 */
export const RESERVED_EDGE_KINDS = {
  schema: "data-at-rest schema shared through a stored artifact",
  lineage: "derivation identity carried by content hashes across versions",
} as const;

/**
 * The enum the contract validates against — derived, never restated.
 *
 * The cast is what `z.enum` needs (a non-empty tuple) and is safe because
 * `EDGE_KINDS` is a non-empty object literal; the element type stays the
 * literal union of its keys, so widening the map widens the enum and the
 * TypeScript type together.
 */
export const EDGE_KIND_VALUES = Object.keys(EDGE_KINDS) as [
  keyof typeof EDGE_KINDS,
  ...(keyof typeof EDGE_KINDS)[],
];

const STATUS_VALUES = [
  "experimental",
  "active",
  "stable",
  "dormant",
  "archived",
];

const Link = z
  .object({
    label: z.enum(["site", "source", "docs", "writing"]),
    // uri-reference, not uri: some links are site-relative.
    href: z.string().min(1),
  })
  .strict();

export const Authored = z
  .object({
    name: z.string(),
    domain: z.string(),
    status: z.enum(STATUS_VALUES),
    // The manifest's authored visibility. Distinct from `repo_visibility`,
    // which is what GitHub reports. Never merge the two.
    visibility: z.enum(["public", "mixed"]),
    question: z.string(),
    primitive: z.string(),
    description: z.string(),
    relationships: z.array(
      z.object({ project: z.string(), verb: z.string() }).strict(),
    ),
  })
  .strict();

export const Coupling = z
  .object({
    project: z.string(),
    // A coupling with no kind says nothing; duplicates say it twice.
    kinds: z.array(z.enum(EDGE_KIND_VALUES)).min(1),
  })
  .strict()
  .meta({ id: "Coupling" });

/**
 * Where an edge was read from.
 *
 * Beyond the file itself, each source format has its own locator — the Cargo
 * table a dependency sat in, the line, the cluster input key, the bundle or
 * wire name, the `_meta` key. They are enumerated rather than allowed through
 * by a passthrough, so `.strict()` keeps meaning what it should: an unknown key
 * is the generator and the contract having drifted apart.
 */
const Evidence = z
  .object({
    repo: z.string().nullable(),
    path: z.string().nullable(),
    format: z.string().nullable(),
    table: z.string().optional(),
    line: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe("1-based line in `path`, when the format carries one."),
    input: z.string().optional(),
    bundle: z.string().optional(),
    wire: z.string().optional(),
    metaKey: z.string().optional(),
  })
  .strict()
  .meta({
    id: "Evidence",
    description:
      "Where a coupling was read from. `repo`/`path`/`format` are always present; the rest are format-specific locators — the Cargo table, the cluster input key, the bundle or wire name, the _meta key. Enumerated rather than open so `additionalProperties: false` keeps meaning that the generator and the contract have drifted apart.",
  });

/**
 * Where a dependency actually resolves from.
 *
 * A manifest can require a name and then override where that name is fetched
 * from — Go's `replace`, Cargo's `path`, npm's `file:`/`link:`/`workspace:`.
 * The requirement reads identically in all three cases; what differs is whether
 * anything published backs it.
 *
 *   published          a registry, module proxy, pinned commit or digest —
 *                      something a third party can fetch and check
 *   path-in-repo       a directory inside the declaring repository — vendored
 *                      or workspace-local; the external name is neutralised
 *   path-outside-repo  a directory OUTSIDE the declaring repository, typically
 *                      a sibling checkout. Nothing published backs this edge and
 *                      it only resolves where both trees happen to be present.
 *   unknown            this format's override syntax is not read yet. Stated so
 *                      a reader can tell missing coverage from a real answer.
 *
 * `published` rather than `registry` because several of these coordinates are
 * not registries: cluster.toml pins `github://<repo>/server.json@<sha>`, a
 * version pin names a release asset, cluster.lock.toml carries an OCI digest.
 * What they share is being fetchable and checkable by someone who is not you.
 */
export const RESOLVES_FROM_VALUES = [
  "published",
  "path-in-repo",
  "path-outside-repo",
  "unknown",
];

export const Edge = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.enum(EDGE_KIND_VALUES),
    resolved_by: z
      .string()
      .min(1)
      .describe(
        "Names a key in this document's top-level `resolution` map, which states the rule and its confidence. JSON Schema cannot express that cross-reference; `deps:check` does, by re-deriving the document.",
      ),
    /**
     * The coordinate this edge's target was found under in `ownership`.
     *
     * `detail` is written for a human and is often not the key that was looked
     * up — a bundle entrypoint reads `/usr/local/bin/mache` while the index is
     * keyed on `mache`. Without this field a reader can see the index and see
     * the edge and still not be able to join them, which would make publishing
     * the index a gesture rather than a check.
     *
     * Null when the resolution consulted no index: `git-url`, `github-ref` and
     * `release-url` read the repository coordinate straight out of a URL.
     */
    matched: z
      .string()
      .nullable()
      .describe(
        "The coordinate this edge's target was found under in `ownership` — the join key. Null when the resolution consulted no index (git-url, github-ref, release-url read the repository straight out of a URL).",
      ),
    resolves_from: z.enum(RESOLVES_FROM_VALUES),
    resolves_via: z
      .string()
      .nullable()
      .describe(
        "The override target verbatim, as a filesystem path, when `resolves_from` is not `published` — e.g. `../signet`. Null otherwise, and null on a redacted edge because a path describes someone's disk.",
      ),
    detail: z
      .string()
      .nullable()
      .describe(
        "Human-readable identifier for the coupling as the source writes it — a module path, an image reference, a bundle entrypoint. NOT the index key: see `matched`. Null when redacted.",
      ),
    version: z.string().nullable(),
    rev: z.string().nullable(),
    redacted: z
      .boolean()
      .describe(
        "True when an endpoint is non-public and the edge has been stripped to its endpoints and kind. Always present: absent-versus-false is a distinction with no meaning, and redaction changes how a null detail should be read.",
      ),
    evidence: Evidence,
  })
  .strict()
  .meta({
    id: "Edge",
    description:
      "One coupling between two repositories. `edges` and `weak_edges` share this shape and differ only in how the target was resolved: an entry in `edges` was identified exactly, one in `weak_edges` only by a name match. Both are real declarations the sources make; the split exists so a name match cannot reach an answer that decides what a release breaks.",
  });

export const Entity = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["project", "repository"]),
    repo: z.string().nullable(),
    // What GitHub reports. `restricted` covers private, renamed and
    // nonexistent alike — the distinction is not stable across callers.
    repo_visibility: z.enum(["public", "restricted"]),
    sources_read: z.boolean(),
    manifests_read: z.number().int().nonnegative(),
    authored: Authored.nullable(),
    derived: z
      .object({
        depends_on: z.array(Coupling),
        depended_on_by: z.array(Coupling),
      })
      .strict(),
    links: z.array(Link),
  })
  .strict()
  .refine((e) => e.kind !== "project" || e.authored !== null, {
    message:
      "a project entity must carry its authored block — that half is the point",
    path: ["authored"],
  });

const Unresolved = z
  .object({
    from: z.string(),
    want: z.string(),
    via: z.string(),
    reason: z.string(),
  })
  .strict();

/**
 * One claim to publish one coordinate.
 *
 * This is the index every `exact` edge is resolved against, and it is published
 * so the resolution is checkable rather than merely asserted. A reader holding
 * only this document can take any edge whose `resolved_by` is exact, look the
 * coordinate up here, and reproduce the answer — no clone, no lock, no trust.
 *
 * It is an ARRAY rather than a coordinate-keyed map on purpose. Two repositories
 * can declare the same coordinate, and a map would silently keep one of them.
 * Collisions are the interesting case, so the shape has to be able to hold one.
 */
const Ownership = z
  .object({
    /** The published name: a module path, crate name, OCI identifier, … */
    coordinate: z.string().min(1),
    /** Which naming system it belongs to — a key of `resolution`. */
    kind: z.string(),
    /** The repository declaring it. */
    repo: z.string(),
    /**
     * The manifest declaring it, relative to that repository's root. This is
     * what gives a monorepo sub-package its own identity: `packages/foo` and
     * the repository root are different `where`s under the same `repo`.
     */
    where: z.string().nullable(),
    /**
     * True when another entry claims the same coordinate. Set on every member
     * of the collision, because "one of these is wrong" is a statement about
     * the set and singling out a winner would be the guess this graph refuses.
     */
    contested: z.boolean(),
  })
  .strict();

const Resolution = z
  .object({
    confidence: z.enum(["exact", "convention", "by-name"]),
    how: z.string(),
  })
  .strict();

export const SiteMap = z
  .object({
    $schema: z.string(),
    schema_version: z.literal(SCHEMA_VERSION),
    note: z.string(),
    /**
     * When the collection this was derived from ran, RFC 3339.
     *
     * Copied from the lock rather than stamped here, so `derive` stays a pure
     * function of the lock and the gate that re-derives it keeps meaning
     * something. This is the field that lets a consumer tell a fresh artifact
     * from a cached one — the map is a point-in-time reading of moving sources,
     * and without it a three-month-old copy is indistinguishable from today's.
     */
    collected_at: z.iso
      .datetime()
      .describe(
        "When the collection this was derived from ran, RFC 3339. The map is a point-in-time reading of moving sources; without this a cached copy is indistinguishable from a current one.",
      ),
    /**
     * True only for a LOCAL artifact built with `--include-private`, which
     * carries detail about repositories the public cannot read and is never
     * published. The map served from xn--w6j.day is always false.
     */
    private_inclusive: z.boolean(),
    site: Site,
    boundary: Boundary,
    entities: z.array(Entity),
    edges: z.array(Edge),
    weak_edges: z.array(Edge),
    unresolved: z.array(Unresolved),
    /** Every coordinate the ecosystem declares publishing, and who declares it. */
    ownership: z.array(Ownership),
    /**
     * What was READ, as against what became an edge.
     *
     * The map only emits edges between repositories it names; a declaration on
     * anything else is parsed and then deliberately dropped as a third-party
     * dependency rather than a coverage gap. That is a defensible scope and it
     * was invisible — a reader saw two dozen edges and could reasonably infer
     * these repositories barely depend on anything.
     *
     * `parsed` counts declarations; `distinct` counts the coordinates they
     * name. Neither is a count of edges, and the gap between them and
     * `edges.length` is the point: it is the difference between this map's
     * scope and the world.
     */
    declarations: z
      .object({
        parsed: z.number().int().nonnegative(),
        distinct: z.number().int().nonnegative(),
      })
      .strict(),
    edge_kinds: z.record(z.string(), z.string()),
    reserved_edge_kinds: z.record(z.string(), z.string()),
    resolution: z.record(z.string(), Resolution),
  })
  .strict()
  /**
   * Cross-references no schema language can express, checked here so they
   * cannot quietly stop being true.
   *
   * Two invariants, and the second was previously enforced by ACCIDENT:
   *
   *   1. `resolved_by` names a key in `resolution`. Documented since the
   *      beginning, but only ever enforced INDIRECTLY — `deps:check`
   *      re-derives the whole document and compares, so a dangling rule
   *      showed up as a diff. That protects this repository, which
   *      re-derives. It does nothing for someone consuming the package with
   *      their own extractors, who has no committed artifact to diff against.
   *
   *   2. Every `kind` used is described in `edge_kinds`. Today the closed
   *      enum guarantees this for free: a kind that is not in the vocabulary
   *      cannot parse. That is the guarantee which DIES the moment the enum
   *      opens for third-party extension — silently, because nothing else
   *      was ever checking it. Written down now, while the enum still makes
   *      it redundant, so that opening the enum is a one-line change rather
   *      than a one-line change plus remembering this.
   *
   * Deliberately on the schema rather than in `checkGraph`: this way anyone
   * who parses gets it, including a consumer of the published package who
   * never runs our gate. JSON Schema cannot carry it — `z.toJSONSchema`
   * simply omits it — so a JSON-Schema-only validator still needs the
   * re-derivation gate, which is why the contract says so.
   */
  .superRefine((doc, ctx) => {
    const described = new Set(Object.keys(doc.edge_kinds));
    const rules = new Set(Object.keys(doc.resolution));

    for (const field of ["edges", "weak_edges"] as const) {
      doc[field].forEach((edge, index) => {
        if (!described.has(edge.kind)) {
          ctx.addIssue({
            code: "custom",
            path: [field, index, "kind"],
            message:
              `edge kind ${JSON.stringify(edge.kind)} is not described in ` +
              `edge_kinds. A consumer reading this document has no way to ` +
              `learn what the coupling means.`,
          });
        }
        if (!rules.has(edge.resolved_by)) {
          ctx.addIssue({
            code: "custom",
            path: [field, index, "resolved_by"],
            message:
              `resolved_by ${JSON.stringify(edge.resolved_by)} names no key ` +
              `in resolution, so the edge's confidence cannot be looked up.`,
          });
        }
      });
    }
  });

/** Keys of the artifact whose value is a list. Derived, never typed out. */
type CollectionKey = {
  // `& string` matters: `keyof` also yields symbol keys, and a mapped type over
  // those degrades the result to something that constrains nothing. An earlier
  // revision omitted it, and removing a key from COLLECTIONS compiled cleanly —
  // the constraint was decoration.
  [K in keyof z.infer<typeof SiteMap> & string]: z.infer<
    typeof SiteMap
  >[K] extends readonly unknown[]
    ? K
    : never;
}[keyof z.infer<typeof SiteMap> & string];

/**
 * What each collection in the artifact is for.
 *
 * Typed as `Record<CollectionKey, string>`, where `CollectionKey` is derived
 * from the contract itself — so adding an array to `SiteMap` without describing
 * it here is a COMPILE ERROR, not a missing paragraph somebody notices later.
 * `ownership` shipped and went undocumented on /api for exactly as long as this
 * was prose in a template.
 *
 * The descriptions stay authored, because "what this collection is for" is a
 * judgment. What is mechanised is that none can be missing.
 */
export const COLLECTIONS: Record<CollectionKey, string> = {
  entities:
    "One per repository, splitting `authored` — a maintainer's statements, which should not be second-guessed from activity signals — from `derived`, which was read from a manifest.",
  edges:
    "Established couplings, each carrying its kind, the file it was read from, `resolved_by` (the rule that identified its target) and `matched` (the coordinate it was found under, so the resolution can be reproduced).",
  weak_edges:
    "Couplings a source declares whose target could only be matched by name. Kept, because deleting a real coupling would be its own distortion, but never folded into `edges`. If you want only what is established, read `edges` and ignore this.",
  unresolved:
    "Declared couplings that resolve to no repository at all, with the reason. A resolution gap is recorded rather than dropped, so the document never looks more resolved than it is. Note the scope: this covers declarations the collector PARSED and could not resolve. A coupling declared in a format it has no parser for is never attempted, so it is absent rather than recorded — see `sources_read` for which formats were actually read, and treat everything else as unexamined rather than empty (0day-11da43 tracks closing this).",
  ownership:
    "Every coordinate the ecosystem declares publishing — module path, crate, package, image, MCP server — and which repository declares it. This is the index every exact edge was resolved against, so a reader can reproduce a resolution rather than take it on trust. A coordinate two repositories claim carries `contested` rather than being reduced to one.",
};
