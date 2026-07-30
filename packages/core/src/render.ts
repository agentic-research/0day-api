/**
 * Render — the diagram, derived.
 *
 * A pure function of the artifact: same graph in, byte-identical SVG out. That
 * is what lets `deps:check` gate the committed picture the same way it gates
 * the committed data, so the diagram cannot quietly stop describing the system.
 *
 * Rank is a fact, not a layout preference. A repository that depends on nothing
 * sits at the bottom; everything else sits one level above the deepest thing it
 * depends on. Order within a rank is alphabetical — arbitrary, but stable, and
 * stability is the whole requirement.
 *
 * Weak couplings used to be omitted, for a good reason: a line on a picture
 * says "this is so", and the data says "we could not establish this". That
 * reasoning holds for a visual language with exactly one kind of line. It stops
 * holding once the picture can say how sure it is — and omitting them was its
 * own error, because a picture that shows nothing where a weak signal exists
 * reports an absence of fact as a fact of absence, which is the rule this
 * project is built on.
 *
 * So line style carries CONFIDENCE, the axis the data actually grades. Three
 * styles, because the artifact uses three: solid for exact, dashed for by-name,
 * dotted for convention.
 *
 * There is no separate "unestablished" style, and the reason is worth keeping.
 * Every asserted edge in this artifact resolves EXACTLY, and every by-name or
 * convention resolution is weak — so "established" and "exact" are one fact
 * with two names, and drawing them as two encodings would invent a distinction
 * the data does not carry. Solid means established because solid means exact.
 * Should a by-name resolution ever be promoted to asserted, this collapses and
 * the picture needs a fourth style; the test below fails loudly if that day
 * arrives, rather than quietly drawing it solid.
 *
 * Kind is not drawn. Four near-identical hues against a near-black field
 * communicated nothing, and kind is already stated in the ledger beneath.
 */

const ROW_HEIGHT = 86;
const NODE_HEIGHT = 26;
const NODE_GAP = 26;
const PADDING = 28;
const CHAR_WIDTH = 7.3;
const MIN_NODE_WIDTH = 78;
// Room beneath the lowest rank for the confidence key.
const LEGEND_HEIGHT = 34;

/**
 * Longest-path rank for every entity.
 *
 * Throws on a cycle rather than carrying a tie-break policy: the asserted graph
 * is a DAG today, and a diagram that silently picks an arbitrary order for a
 * cycle is worse than one that refuses and names it.
 */
export function rankEntities(graph: any): Map<string, number> {
  // Rank 0 asserts "depends on nothing". For a repository whose manifests were
  // never read, that is not established — it is merely unobserved, and the two
  // are the distinction this whole project exists to keep. Such an entity only
  // reaches the artifact by being named in someone else's manifest; if that
  // ever happens, the picture needs a band for it rather than a rank.
  const unread = graph.entities.filter((e: any) => e.sources_read === false);
  if (unread.length > 0) {
    throw new Error(
      "cannot rank an entity whose sources were not read — its dependencies " +
        `are unobserved, not absent: ${unread.map((e: any) => e.id).join(", ")}`,
    );
  }

  const dependsOn = new Map<string, Set<string>>(
    graph.entities.map((e: any) => [e.id, new Set<string>()]),
  );
  for (const edge of graph.edges) {
    if (!dependsOn.has(edge.from) || !dependsOn.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    dependsOn.get(edge.from)!.add(edge.to);
  }

  const rank = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string, trail: string[]): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(" → ");
      throw new Error(
        `the asserted graph contains a cycle and cannot be ranked: ${cycle}`,
      );
    }
    visiting.add(id);
    let depth = 0;
    for (const target of [...(dependsOn.get(id) ?? [])].sort()) {
      depth = Math.max(depth, resolve(target, [...trail, id]) + 1);
    }
    visiting.delete(id);
    rank.set(id, depth);
    return depth;
  };

  for (const entity of [...graph.entities].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  )) {
    resolve(entity.id, []);
  }
  return rank;
}

const nodeWidth = (id: string): number =>
  Math.max(MIN_NODE_WIDTH, Math.round(id.length * CHAR_WIDTH + 22));

/** Place every entity. Rank 0 at the bottom, rank increasing upward. */
export function layout(graph: any) {
  const rank = rankEntities(graph);
  const maxRank = Math.max(0, ...rank.values());

  const rows: string[][] = [];
  for (let r = 0; r <= maxRank; r += 1) {
    rows[r] = graph.entities
      .filter((e: any) => rank.get(e.id) === r)
      .map((e: any) => e.id)
      .sort();
  }

  const rowWidth = (ids: string[]): number =>
    ids.reduce((sum, id) => sum + nodeWidth(id), 0) +
    Math.max(0, ids.length - 1) * NODE_GAP;

  const width = Math.max(320, ...rows.map(rowWidth)) + PADDING * 2;
  const height =
    (maxRank + 1) * ROW_HEIGHT +
    PADDING * 2 -
    (ROW_HEIGHT - NODE_HEIGHT) +
    LEGEND_HEIGHT;

  const placed = new Map<
    string,
    { id: string; rank: number; x: number; y: number; w: number; h: number }
  >();
  rows.forEach((ids, r) => {
    let x = Math.round((width - rowWidth(ids)) / 2);
    // Rank 0 at the bottom: higher rank sits nearer the top of the canvas.
    const y = PADDING + (maxRank - r) * ROW_HEIGHT;
    for (const id of ids) {
      const w = nodeWidth(id);
      placed.set(id, { id, rank: r, x, y, w, h: NODE_HEIGHT });
      x += w + NODE_GAP;
    }
  });

  return { width, height, maxRank, nodes: placed };
}

const escapeXml = (s: unknown): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Edge geometry.
 *
 * A dependency leaves the bottom of the dependant and arrives at the top of the
 * dependency, so every line is read the same way: downward means "rests on".
 */
function edgePath(from: any, to: any): string {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  const midY = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`;
}

const STYLE = `
  .bg { fill: #0d0f12; }
  .node-box { fill: #13161b; stroke: #292e35; }
  .node-label {
    font: 12px "SFMono-Regular", Menlo, Consolas, monospace;
    fill: #e7e3da;
    dominant-baseline: middle;
    text-anchor: middle;
  }
  .rank-label {
    font: 10px "SFMono-Regular", Menlo, Consolas, monospace;
    fill: #626872;
    dominant-baseline: middle;
  }
  /* Line style is CONFIDENCE. Kind lives in the ledger, not the picture. */
  .edge { fill: none; stroke: #8f9aa6; stroke-width: 1.15; }
  .edge--exact { stroke: #b9c4cf; }
  .edge--by-name { stroke: #8f9aa6; stroke-dasharray: 5 3; }
  .edge--convention { stroke: #7c8590; stroke-dasharray: 1 3; }
  /* Weak resolutions are present because omitting them would assert an
     absence — dimmer, so they never read as the established backbone. */
  .edge--weak { opacity: 0.62; }
  .legend-label {
    font: 9.5px "SFMono-Regular", Menlo, Consolas, monospace;
    fill: #626872;
    dominant-baseline: middle;
  }
`.trim();

/**
 * Render the artifact as a standalone SVG.
 *
 * @param {object} graph a document satisfying the published contract
 * @returns {string} deterministic SVG
 */
export function render(graph: any): string {
  const { width, height, maxRank, nodes } = layout(graph);

  /**
   * How sure the artifact is about an edge, taken from the resolution table it
   * publishes rather than assumed here. An unrecognised method is treated as
   * the weakest reading, because guessing upward is the one direction that
   * turns a hedge into an assertion.
   */
  const confidenceOf = (edge: any): string => {
    const stated = graph.resolution?.[edge.resolved_by]?.confidence;
    return stated === "exact" || stated === "by-name" ? stated : "convention";
  };

  const draworder = (list: any[]) =>
    [...list]
      .filter(
        (e: any) => nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to,
      )
      .sort((a: any, b: any) =>
        `${a.from}${a.to}${a.kind}` < `${b.from}${b.to}${b.kind}` ? -1 : 1,
      );

  const seen = new Set<string>();
  const paths: string[] = [];

  // Unestablished couplings are laid down first, so an asserted line always
  // draws over a weak one rather than being obscured by it.
  let unestablished = 0;
  for (const edge of draworder(graph.weak_edges ?? [])) {
    const key = `${edge.from} ${edge.to} ${edge.kind}`;
    const alsoAsserted = (graph.edges ?? []).some(
      (e: any) =>
        e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
    );
    if (alsoAsserted || seen.has(`weak ${key}`)) continue;
    seen.add(`weak ${key}`);
    unestablished += 1;
    const confidence = confidenceOf(edge);
    paths.push(
      `    <path class="edge edge--weak edge--${confidence}" d="${edgePath(nodes.get(edge.from)!, nodes.get(edge.to)!)}"><title>${escapeXml(`${edge.from} → ${edge.to} (${edge.kind}, ${confidence}, not established)`)}</title></path>`,
    );
  }

  let asserted = 0;
  for (const edge of draworder(graph.edges ?? [])) {
    // One line per pair per kind; several declarations of the same coupling are
    // the same line.
    const key = `${edge.from} ${edge.to} ${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    asserted += 1;
    const confidence = confidenceOf(edge);
    paths.push(
      `    <path class="edge edge--${confidence}" d="${edgePath(nodes.get(edge.from)!, nodes.get(edge.to)!)}"><title>${escapeXml(`${edge.from} → ${edge.to} (${edge.kind}, ${confidence})`)}</title></path>`,
    );
  }

  // The key. Static and ordered, so the output stays byte-stable.
  const legendY = height - PADDING / 2 - 8;
  const legend: string[] = [];
  const KEY: [string, string][] = [
    ["exact", "exact — established"],
    ["by-name", "by name — weak"],
    ["convention", "convention — weak"],
  ];
  let lx = PADDING;
  for (const [cls, label] of KEY) {
    legend.push(
      `    <path class="edge edge--${cls}" d="M${lx} ${legendY} L${lx + 22} ${legendY}" />`,
    );
    legend.push(
      `    <text class="legend-label" x="${lx + 27}" y="${legendY}">${escapeXml(label)}</text>`,
    );
    lx += 27 + Math.round(label.length * 5.7) + 22;
  }

  // No archived styling: an archived project leaves the roster, so it never
  // becomes an entity and can never reach this function. Styling for a state
  // that cannot occur is dead code, and a test for it passes over an empty set
  // — which is the vacuity this project keeps having to root out.
  const boxes = [...nodes.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(
      (n) =>
        `    <g class="node"><rect class="node-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" /><text class="node-label" x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 1}">${escapeXml(n.id)}</text></g>`,
    );

  const rankLabels: string[] = [];
  for (let r = 0; r <= maxRank; r += 1) {
    const y = PADDING + (maxRank - r) * ROW_HEIGHT + NODE_HEIGHT / 2;
    rankLabels.push(`    <text class="rank-label" x="6" y="${y}">${r}</text>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Derived dependency graph: ${graph.entities.length} repositories, ${asserted} established couplings and ${unestablished} not established, ranked by dependency depth. Line style carries confidence.">`,
    `  <style>${STYLE}</style>`,
    `  <rect class="bg" x="0" y="0" width="${width}" height="${height}" />`,
    `  <g class="edges">`,
    ...paths,
    `  </g>`,
    `  <g class="ranks">`,
    ...rankLabels,
    `  </g>`,
    `  <g class="nodes">`,
    ...boxes,
    `  </g>`,
    `  <g class="legend">`,
    ...legend,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}
