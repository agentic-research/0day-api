/**
 * Inspect — read ONE repository and resolve what it declares against the
 * published ownership index (0day-695699).
 *
 * Every other verb in this tool operates on the roster: it reads the whole
 * ecosystem and writes the committed artifact. This one answers a narrower and
 * more portable question — *given this repository, and the map as published,
 * what does it publish and what does it depend on* — and it answers it with
 * exactly one repository on disk.
 *
 * That last property is the point, and it is the same one this repository keeps
 * arriving at from other directions: a check that needs two checkouts to say
 * anything says nothing on a fresh runner. Here the second side arrives over
 * HTTP, from an artifact that is already public, versioned and schema'd. So
 * this works in a repository that is not in the roster, has never been in the
 * roster, and has no relationship to it beyond consuming the same names.
 *
 * It writes nothing. `collect`/`derive`/`render` own the write path.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { collectRepo } from "./collect.js";
import { localProvider } from "./providers.js";

/** Path at which a deployment serves its map, relative to its origin. */
export const PUBLISHED_INDEX_PATH = "/.well-known/site-map.json";

/**
 * The reference deployment, used only as a default so `inspect` is useful with
 * no configuration.
 *
 * Unlike `$schema` in the derived artifact — which must never default, because
 * a wrong value there is a false claim baked into published data — this one is
 * merely where to look something up. A caller pointing at their own map passes
 * their own URL, and a wrong default costs a failed fetch rather than a
 * plausible-looking lie.
 */
export const PUBLISHED_INDEX_URL = "https://xn--w6j.day" + PUBLISHED_INDEX_PATH;

type OwnershipEntry = {
  coordinate: string;
  kind: string;
  repo: string;
  where: string | null;
  contested: boolean;
};

export type Requirement = {
  /** The coordinate as the manifest writes it. */
  coordinate: string;
  /** Which naming system it belongs to. */
  kind: string;
  /** The manifest that declares it. */
  where: string;
  /** Resolved publisher, or null when the index does not contain it. */
  repo: string | null;
  /** The index coordinate that matched — may be a prefix, for Go modules. */
  matched: string | null;
  /** True when more than one repository claims `matched`. */
  contested: boolean;
};

export type InspectReport = {
  repo: string;
  root: string;
  index: { url: string; schema_version: number; entries: number };
  publishes: { coordinate: string; kind: string; where: string }[];
  requires: Requirement[];
  notes: string[];
};

/**
 * What a manifest DECLARES PUBLISHING, as coordinates.
 *
 * Deliberately the same shape derive.ts indexes, because the point is for the
 * answers to line up: a repository inspected here should report publishing the
 * same coordinates the published index would list for it, if it were a roster
 * member.
 */
function publishesOf(
  source: any,
): { coordinate: string; kind: string; where: string }[] {
  const { path: where, format, facts } = source;
  switch (format) {
    case "cargo":
      return (facts.publishes ?? []).map((c: string) => ({
        coordinate: c,
        kind: "crate-name",
        where,
      }));
    case "gomod":
      return facts.module
        ? [{ coordinate: facts.module, kind: "go-module-path", where }]
        : [];
    case "npm":
      return (facts.publishes ?? []).map((c: string) => ({
        coordinate: c,
        kind: "npm-package-name",
        where,
      }));
    case "server-json": {
      const out: { coordinate: string; kind: string; where: string }[] = [];
      if (facts.name)
        out.push({ coordinate: facts.name, kind: "mcp-server-name", where });
      for (const pkg of facts.packages ?? []) {
        if (pkg.identifier)
          out.push({
            coordinate: pkg.identifier,
            kind: "oci-identifier",
            where,
          });
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * What a manifest DEPENDS ON, as coordinates.
 *
 * Coverage is the three package managers plus MCP required-deps. cluster.toml
 * inputs and version pins are not read here: they resolve through rules that
 * need more than a coordinate lookup (a github:// ref, a filename convention),
 * and half-implementing them would report a confident nothing. Their absence is
 * stated in the report's notes rather than left for the reader to notice.
 */
function requiresOf(
  source: any,
): { coordinate: string; kind: string; where: string }[] {
  const { path: where, format, facts } = source;
  switch (format) {
    case "cargo":
      return (facts.deps ?? [])
        .filter((d: any) => !d.git)
        .map((d: any) => ({
          coordinate: d.package ?? d.name,
          kind: "crate-name",
          where,
        }));
    case "gomod":
      return (facts.requires ?? [])
        .filter((r: any) => !r.indirect)
        .map((r: any) => ({
          coordinate: r.path,
          kind: "go-module-path",
          where,
        }));
    case "npm":
      return (facts.deps ?? []).map((d: any) => ({
        coordinate: d.name,
        kind: "npm-package-name",
        where,
      }));
    case "server-json":
      return (facts.requiredDeps ?? []).map((d: any) => ({
        coordinate: d.server,
        kind: "mcp-server-name",
        where,
      }));
    default:
      return [];
  }
}

/**
 * Resolve one coordinate against the published index.
 *
 * Go module paths resolve by longest prefix — a nested module belongs to
 * whoever publishes the closest enclosing path — which is the same rule
 * derive.ts applies, restated here because this side has only the published
 * index and not the lock.
 */
function resolveAgainst(
  ownership: OwnershipEntry[],
  coordinate: string,
  kind: string,
): { repo: string | null; matched: string | null; contested: boolean } {
  const exact = ownership.filter(
    (o) => o.kind === kind && o.coordinate === coordinate,
  );
  if (exact.length > 0) {
    return {
      repo: exact[0].repo,
      matched: exact[0].coordinate,
      contested: exact.some((o) => o.contested),
    };
  }
  if (kind === "go-module-path") {
    let best: OwnershipEntry | null = null;
    for (const o of ownership) {
      if (o.kind !== "go-module-path") continue;
      if (
        coordinate === o.coordinate ||
        coordinate.startsWith(o.coordinate + "/")
      ) {
        if (!best || o.coordinate.length > best.coordinate.length) best = o;
      }
    }
    if (best) {
      return {
        repo: best.repo,
        matched: best.coordinate,
        contested: best.contested,
      };
    }
  }
  return { repo: null, matched: null, contested: false };
}

/**
 * Fetch the published map.
 *
 * `file://` is handled explicitly rather than left to `fetch`, which does not
 * support it. That is what lets this be checked against a local artifact — and
 * it is how the tests run with no network, which matters for a feature whose
 * whole claim is that it needs nothing but the repository in front of it.
 */
export async function fetchPublishedIndex(
  url: string = PUBLISHED_INDEX_URL,
): Promise<{ schema_version: number; ownership: OwnershipEntry[] }> {
  let doc: any;
  if (url.startsWith("file://")) {
    doc = JSON.parse(await readFile(fileURLToPath(url), "utf8"));
  } else {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    doc = await response.json();
  }
  if (!Array.isArray(doc.ownership)) {
    throw new Error(
      `${url} carries no ownership index — it may predate schema version 1`,
    );
  }
  return { schema_version: doc.schema_version, ownership: doc.ownership };
}

/**
 * Inspect one repository.
 *
 * @param root      path to the repository — roster member or not
 * @param published the ownership index, already fetched
 */
export async function inspectRepo(
  root: string,
  published: { schema_version: number; ownership: OwnershipEntry[] },
  { url = PUBLISHED_INDEX_URL }: { url?: string } = {},
): Promise<InspectReport> {
  const slug = root.replace(/\/+$/, "").split("/").pop() || root;
  // The slug is a LABEL for output, not a claim of roster membership. Nothing
  // downstream looks it up, and a repository that shares a name with a roster
  // entry gets no privileges from that.
  const { sources, notes } = await collectRepo(slug, localProvider(root));

  const publishes = sources
    .flatMap(publishesOf)
    .sort((a, b) => (a.coordinate < b.coordinate ? -1 : 1));

  const seen = new Set<string>();
  const requires: Requirement[] = [];
  for (const source of sources) {
    for (const want of requiresOf(source)) {
      const key = `${want.kind} ${want.coordinate} ${want.where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requires.push({
        ...want,
        ...resolveAgainst(published.ownership, want.coordinate, want.kind),
      });
    }
  }
  requires.sort((a, b) => (a.coordinate < b.coordinate ? -1 : 1));

  const formats = new Set(sources.map((s: any) => s.format));
  const unread = [
    "cluster-toml",
    "cluster-lock",
    "version-pin",
    "taskfile",
  ].filter((f) => formats.has(f));
  if (unread.length > 0) {
    notes.push(
      `read but not resolved here: ${unread.join(", ")} — these resolve through rules ` +
        "that need more than a coordinate lookup, so they are omitted rather than " +
        "reported as declaring nothing",
    );
  }

  return {
    repo: slug,
    root,
    index: {
      url,
      schema_version: published.schema_version,
      entries: published.ownership.length,
    },
    publishes,
    requires,
    notes,
  };
}

/** Render a report for a terminal. */
export function formatReport(report: InspectReport): string {
  const lines: string[] = [];
  lines.push(`${report.repo}  (${report.root})`);
  lines.push(
    `resolved against ${report.index.url} — schema v${report.index.schema_version}, ${report.index.entries} coordinates`,
  );
  lines.push("");

  lines.push(`publishes (${report.publishes.length})`);
  if (report.publishes.length === 0) lines.push("  (nothing)");
  for (const p of report.publishes) {
    lines.push(`  ${p.coordinate}  [${p.kind}]  ${p.where}`);
  }
  lines.push("");

  const known = report.requires.filter((r) => r.repo);
  const unknown = report.requires.filter((r) => !r.repo);

  lines.push(`depends on, resolved (${known.length})`);
  if (known.length === 0) lines.push("  (nothing in the published index)");
  for (const r of known) {
    const via = r.matched === r.coordinate ? "" : `  via ${r.matched}`;
    const contest = r.contested ? "  ** CONTESTED **" : "";
    lines.push(`  ${r.repo}  ${r.coordinate}  [${r.kind}]${via}${contest}`);
  }
  lines.push("");

  // Named, never silent. A coordinate the map does not know is the interesting
  // half of this report: it is either a third-party dependency or a gap in the
  // map, and collapsing it to "no dependency" would hide both.
  lines.push(`not in the published index (${unknown.length})`);
  if (unknown.length === 0) lines.push("  (none)");
  for (const r of unknown) {
    lines.push(`  ${r.coordinate}  [${r.kind}]  ${r.where}`);
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("notes");
    for (const n of report.notes) lines.push(`  ${n}`);
  }

  return lines.join("\n");
}
