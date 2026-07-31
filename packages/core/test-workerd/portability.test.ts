/**
 * Does the "portable core" claim actually hold?
 *
 * The package README says this half runs in workerd, a Durable Object or a
 * browser, and the whole core/collect split is justified by that claim. A
 * claim nobody executes is the failure mode this project exists to argue
 * against, so it is executed here: these tests import the package's real
 * exports INSIDE a simulated workerd runtime and run the derivation.
 *
 * What would break it is not hypothetical. `zod` and `smol-toml` are the only
 * dependencies, but a transitive `node:` import, a `process` reference or a
 * `Buffer` would all typecheck under Node and fail here.
 */
import { describe, expect, it } from "vitest";
import {
  SiteMap,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  buildOwnership,
  derive,
  schemaUrl,
} from "../src/index.js";

/**
 * The smallest lock that is still a real one: two repos, and a declared
 * dependency from one on a crate the other publishes — so `derive` has an edge
 * to actually resolve rather than an empty set to trivially agree about.
 *
 * The shape is taken from a real `sources.lock.json`, not invented: sources
 * carry PARSED `facts`, never raw file content. Parsing happens at collect
 * time so that deriving stays pure, which is the same boundary this test
 * exists to defend.
 */
/** Deployment identity — required now that it is not hard-coded in derive. */
const SITE = {
  name: "example map",
  url: "https://example.com",
  describes: "example-org",
};

const lock = {
  schema_version: 1,
  collected_at: "2026-01-01T00:00:00.000Z",
  private_inclusive: false,
  repos: [
    {
      slug: "alpha",
      github: "example/alpha",
      visibility: "public",
      on_map: true,
      read: true,
    },
    {
      slug: "beta",
      github: "example/beta",
      visibility: "public",
      on_map: true,
      read: true,
    },
  ],
  sources: [
    {
      repo: "beta",
      path: "Cargo.toml",
      blob: "0".repeat(40),
      format: "cargo",
      facts: {
        package: "beta-crate",
        publishes: ["beta-crate"],
        workspaceMembers: [],
        deps: [],
      },
    },
    {
      repo: "alpha",
      path: "Cargo.toml",
      blob: "1".repeat(40),
      format: "cargo",
      facts: {
        package: "alpha",
        publishes: ["alpha"],
        workspaceMembers: [],
        deps: [{ name: "beta-crate", version: "1.0.0" }],
      },
    },
  ],
};

describe("depgraph-core under workerd", () => {
  it("loads at all — module init runs zod and smol-toml in the runtime", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(SCHEMA_PATH).toBe("/schema/v1/site-map.json");
  });

  it("builds absolute schema URLs with the platform URL, not Node's", () => {
    expect(schemaUrl("https://example.com")).toBe(
      "https://example.com/schema/v1/site-map.json",
    );
  });

  it("parses a manifest and builds the ownership index", () => {
    const index = buildOwnership(lock as never);
    expect(index).toBeTruthy();
  });

  it("derives a document that satisfies its own published contract", () => {
    const doc = derive(lock as never, [], {
      origin: "https://example.com",
      site: SITE,
    });

    // Validated with the contract rather than by shape-eyeballing: if zod's
    // runtime behaviour differed here, this is where it would show.
    const parsed = SiteMap.safeParse(doc);
    expect(parsed.success).toBe(true);
    expect(doc.$schema).toBe("https://example.com/schema/v1/site-map.json");

    // A derivation that resolved NOTHING would satisfy every assertion above,
    // and would prove only that an empty document is valid. The fixture
    // declares alpha -> beta-crate, which beta publishes, so the resolution
    // has to actually happen here — in workerd — for this to pass.
    expect(doc.entities.length).toBe(2);
    expect(doc.edges.length).toBeGreaterThan(0);
    const edge = doc.edges[0]!;
    expect(edge.from).toBe("alpha");
    expect(edge.to).toBe("beta");
  });

  it("is deterministic — the property the whole gate depends on", () => {
    const a = derive(lock as never, [], {
      origin: "https://example.com",
      site: SITE,
    });
    const b = derive(lock as never, [], {
      origin: "https://example.com",
      site: SITE,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
