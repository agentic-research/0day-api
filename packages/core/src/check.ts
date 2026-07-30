/**
 * Check — the gate.
 *
 * Pure and offline by construction: it takes the two committed documents as
 * text and answers whether the graph is exactly the lock's derivation, and
 * whether it discloses anything about a non-public repository. Nothing here
 * reads a file, so `selftest.ts` can run the real gate against deliberately
 * broken input and prove it fails, rather than proving only that it passes
 * today.
 */

import { derive } from "./derive.js";
import type { SourcesLock } from "./sources-lock.js";

type SiteMapDoc = import("zod").infer<typeof SiteMap>;
type CheckResult = { ok: boolean; reason: string | null; message: string };
import { SiteMap } from "./site-map.js";

export const serialize = (doc: unknown): string =>
  JSON.stringify(doc, null, 2) + "\n";

/** First differing line of two serialized documents, with leading context. */
export function firstDifference(
  expected: string,
  actual: string,
): { line: number; context: string } | null {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    const from = Math.max(0, i - 3);
    const lines = [];
    for (let j = from; j < i; j += 1) lines.push(`  ${a[j]}`);
    lines.push(`- expected:  ${a[i] ?? "<end of file>"}`);
    lines.push(`+ committed: ${b[i] ?? "<end of file>"}`);
    return { line: i + 1, context: lines.join("\n") };
  }
  return null;
}

/**
 * Every edge touching a non-public repository must carry its endpoints and
 * coupling kind and nothing else. Asserted against the committed artifact, not
 * trusted from the code that wrote it — the point of a gate is that it does not
 * take the generator's word for anything.
 */
export function privacyViolations(graph: SiteMapDoc): string[] {
  const visibility = new Map(
    graph.entities.map((e) => [e.id, e.repo_visibility]),
  );
  const problems: string[] = [];

  for (const edge of [...graph.edges, ...(graph.weak_edges ?? [])]) {
    const isPublic =
      visibility.get(edge.from) === "public" &&
      visibility.get(edge.to) === "public";
    if (isPublic) continue;
    for (const field of ["detail", "version", "rev"] as const) {
      if (edge[field] != null) {
        problems.push(
          `${edge.from} -> ${edge.to} (${edge.kind}) discloses ${field}: ${JSON.stringify(edge[field])}`,
        );
      }
    }
    if (edge.evidence?.path != null) {
      problems.push(
        `${edge.from} -> ${edge.to} (${edge.kind}) discloses evidence.path: ${edge.evidence.path}`,
      );
    }
  }

  for (const entity of graph.entities) {
    if (entity.repo_visibility !== "public" && entity.sources_read) {
      problems.push(
        `${entity.id} is ${entity.repo_visibility} but the lock claims its manifests were read`,
      );
    }
  }

  return problems;
}

/**
 * Run the gate.
 *
 * @param {{lockText: string, graphText: string}} input
 * @returns {{ok: boolean, reason: string|null, message: string}}
 */
export function checkGraph({
  lockText,
  graphText,
  projects = [],
  origin,
}: {
  lockText: string;
  graphText: string;
  projects?: any[];
  /**
   * The deployment origin the committed artifact was derived for.
   *
   * The gate re-derives and compares byte-for-byte, so it has to reproduce
   * the `$schema` the artifact carries. Defaulting this would make the gate
   * pass for an artifact derived against a different origin — a check that
   * reports agreement it never established.
   */
  origin: string;
}): CheckResult {
  let lock: SourcesLock;
  let graph: SiteMapDoc;
  try {
    lock = JSON.parse(lockText);
  } catch (error) {
    return {
      ok: false,
      reason: "lock-unparseable",
      message: `data/sources.lock.json is not valid JSON: ${(error as Error).message}`,
    };
  }
  try {
    graph = JSON.parse(graphText);
  } catch (error) {
    return {
      ok: false,
      reason: "graph-unparseable",
      message: `data/graph.json is not valid JSON: ${(error as Error).message}`,
    };
  }

  // Shape first. The artifact is what other people's tools read, so a broken
  // promise to every consumer should be reported as such rather than as a diff
  // against the sources — which is what a missing field would otherwise look
  // like.
  const shape = SiteMap.safeParse(graph);
  if (!shape.success) {
    const first = shape.error.issues[0];
    return {
      ok: false,
      reason: "schema",
      message:
        "data/graph.json does not satisfy the published contract.\n" +
        "\n" +
        `  ${first.path.join(".") || "<root>"}: ${first.message}\n` +
        (shape.error.issues.length > 1
          ? `  …and ${shape.error.issues.length - 1} more\n`
          : "") +
        "\n" +
        "  Fix with: task deps:derive",
    };
  }

  const expectedText = serialize(derive(lock, projects, { origin }));
  if (graphText !== expectedText) {
    const diff = firstDifference(expectedText, graphText);
    return {
      ok: false,
      reason: "divergent",
      message:
        "data/graph.json is not the derivation of data/sources.lock.json.\n" +
        "\n" +
        "  The graph is generated. Editing it by hand — or changing the lock\n" +
        "  without regenerating — produces a map that states something no\n" +
        "  source declares.\n" +
        "\n" +
        `  First difference at line ${diff?.line}:\n${diff?.context}\n` +
        "\n" +
        "  Fix with: task deps:derive",
    };
  }

  const leaks = privacyViolations(graph);
  if (leaks.length > 0) {
    return {
      ok: false,
      reason: "privacy",
      message:
        "The committed graph discloses detail about a non-public repository.\n" +
        leaks.map((l) => `  ${l}`).join("\n"),
    };
  }

  const nonPublic = graph.entities.filter(
    (e) => e.repo_visibility !== "public",
  ).length;
  return {
    ok: true,
    reason: null,
    message:
      `${graph.edges.length} edges derive exactly from the lock; ` +
      `${nonPublic} non-public endpoints carry no detail`,
  };
}
