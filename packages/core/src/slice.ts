/**
 * Reading one entity out of the artifact.
 *
 * These lived in 0day's `src/data/graph.ts`, closing over a module-scope
 * `graph` imported from a fixed path. That made them untestable against any
 * document but one, and unusable by anyone consuming the package — the logic
 * was general and the binding was not.
 *
 * Every function here takes the document. Nothing imports data.
 */

import type { z } from "zod";
import { SiteMap, schemaUrl } from "./site-map.js";

type SiteMapDoc = z.infer<typeof SiteMap>;
type Edge = SiteMapDoc["edges"][number];
type Unresolved = SiteMapDoc["unresolved"][number];
type Confidence = SiteMapDoc["resolution"][string]["confidence"];

/**
 * Edges to or from one project, collapsed to a single row.
 *
 * Distinct from the contract's `Coupling`, which publishes `{project, kinds}`
 * on an entity and deliberately omits the edges. This carries them, because a
 * slice's whole purpose is that a reader can check the claim without fetching
 * anything else.
 */
export interface EdgeGroup {
  project: string;
  kinds: Edge["kind"][];
  edges: Edge[];
}

function group(edges: Edge[], side: "to" | "from"): EdgeGroup[] {
  const byProject = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = edge[side];
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(edge);
  }
  return [...byProject.entries()]
    .map(([project, projectEdges]) => ({
      project,
      kinds: [...new Set(projectEdges.map((e) => e.kind))].sort(),
      edges: projectEdges,
    }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

/** What `slug` depends on, grouped by target. */
export function dependenciesOf(graph: SiteMapDoc, slug: string): EdgeGroup[] {
  return group(
    graph.edges.filter((edge) => edge.from === slug),
    "to",
  );
}

/** What depends on `slug`, grouped by source. */
export function dependentsOf(graph: SiteMapDoc, slug: string): EdgeGroup[] {
  return group(
    graph.edges.filter((edge) => edge.to === slug),
    "from",
  );
}

/** Name-matched couplings recorded against `slug`, in either direction. */
export function weakFor(graph: SiteMapDoc, slug: string): Edge[] {
  return graph.weak_edges.filter(
    (edge) => edge.from === slug || edge.to === slug,
  );
}

/** Resolution gaps recorded against `slug`, if any. */
export function unresolvedFor(graph: SiteMapDoc, slug: string): Unresolved[] {
  return graph.unresolved.filter((item) => item.from === slug);
}

/**
 * The confidence of an edge's resolution.
 *
 * Falls back to `by-name` — the weakest — when the rule is not in the
 * document's `resolution` map. Failing open to the strongest would let a
 * dangling `resolved_by` read as an exact resolution, which is the one
 * mistake this vocabulary exists to prevent. `SiteMap`'s refinement rejects
 * such a document anyway; this is what happens if one is read unvalidated.
 */
export function confidenceOf(graph: SiteMapDoc, edge: Edge): Confidence {
  return graph.resolution[edge.resolved_by]?.confidence ?? "by-name";
}

/**
 * One entity as a standalone document.
 *
 * SELF-CONTAINED IS THE CONTRACT. The slice carries the `resolution` rules its
 * own edges cite and the `ownership` rows for what this repository publishes,
 * so every claim in it can be read and reproduced without fetching the whole
 * artifact. Carrying the full tables would just be the artifact again; carrying
 * neither would leave `resolved_by` an opaque token.
 *
 * `origin` is required for the same reason `derive` requires it: `$schema`
 * names the contract this document claims to satisfy, and a default would have
 * every deployment's slices point at somebody else's.
 */
export function sliceFor(
  graph: SiteMapDoc,
  slug: string,
  options: { origin: string },
) {
  const depends = dependenciesOf(graph, slug);
  const dependedOn = dependentsOf(graph, slug);
  const weak = weakFor(graph, slug);

  const cited = new Set(
    [
      ...depends.flatMap((c) => c.edges),
      ...dependedOn.flatMap((c) => c.edges),
      ...weak,
    ].map((edge) => edge.resolved_by),
  );

  return {
    $schema: schemaUrl(options.origin),
    schema_version: graph.schema_version,
    note:
      `A single entity from ${graph.site.url}/.well-known/site-map.json, ` +
      "carrying the resolution rules its own edges cite and the coordinates it " +
      "declares publishing, so nothing else has to be fetched to read it. " +
      "Generated — do not edit.",
    // Repeated rather than linked: a slice whose freshness lived in another
    // document would be the restatement this project exists to remove.
    collected_at: graph.collected_at,
    entity: graph.entities.find((entity) => entity.id === slug) ?? null,
    depends_on: depends,
    depended_on_by: dependedOn,
    // Kept separate for the same reason the artifact keeps them separate: a
    // name-matched coupling read as an asserted one is the specific mistake
    // this graph refuses to invite.
    weak_edges: weak,
    unresolved: unresolvedFor(graph, slug),
    ownership: graph.ownership.filter((entry) => entry.repo === slug),
    resolution: Object.fromEntries(
      Object.entries(graph.resolution).filter(([rule]) => cited.has(rule)),
    ),
  };
}
