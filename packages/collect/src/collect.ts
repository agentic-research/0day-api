/**
 * Collect — turn every machine-readable manifest in the roster into normalized
 * facts.
 *
 * The output is `data/sources.lock.json`: the complete set of declarations the
 * graph is derived from, plus the content address of each manifest read and the
 * time the collection ran.
 *
 * This file used to say it carried "no timestamps and no commit ids, so it is
 * stable under re-collection". That stability is still the property that makes
 * a diff meaningful, but it now lives one level in: the CANONICAL bytes
 * (`canonicalLockBytes`, everything but `collected_at`) are stable under
 * re-collection, and `deps:verify` compares those. `collected_at` is the single
 * field allowed to differ, and it exists because a provenance claim without a
 * time proves integrity but not recency (0day-69356e).
 *
 * Each source carries `blob`, the git blob SHA of the manifest actually parsed.
 * Both providers produce it and must agree: GitHub reads it from the tree
 * listing it already fetches, local computes `sha1("blob <len>\0" + bytes)`.
 * That is what makes the collection a claim about specific bytes rather than
 * about a path that may since have moved — APAS §1.1's "mutable references are
 * attack vectors" applied to this repository's own inputs.
 *
 * Two rules hold here:
 *
 *   - Visibility fails closed. A repository is read only when GitHub says it is
 *     public. If visibility cannot be established for anything, the collection
 *     fails rather than quietly emitting a graph missing half its edges.
 *   - Nothing is dropped silently. Unparseable manifests, directories below the
 *     depth cap that hold manifests, and truncated listings are all reported.
 */

import { createHash } from "node:crypto";

import {
  extractCargo,
  extractClusterLock,
  extractClusterToml,
  extractGoMod,
  extractNpm,
  extractServerJson,
  extractTaskfile,
  extractVersionPin,
  extractWorkflow,
} from "./extract.js";
import {
  githubProvider,
  localProvider,
  privateProvider,
  mapLimit,
  MAX_DEPTH,
  selectManifests,
} from "./providers.js";

export const LOCK_SCHEMA_VERSION = 1;

const EXTRACT = {
  cargo: extractCargo,
  gomod: extractGoMod,
  npm: extractNpm,
  "server-json": extractServerJson,
  "cluster-toml": extractClusterToml,
  "cluster-lock": extractClusterLock,
  taskfile: extractTaskfile,
  workflow: extractWorkflow,
};

/**
 * Establish whether a repository is public. Two values only: "public", or
 * "restricted" for everything else.
 *
 * The distinction between "private", "does not exist" and "not visible to this
 * caller" is deliberately not recorded. It is not stable across credentials,
 * and a lock whose contents depend on who ran it cannot be verified by anyone
 * else. All three mean the same thing here: do not read it, and disclose
 * nothing about it.
 *
 * The answer always comes from the unauthenticated GitHub probe, in both local
 * and remote mode, so the two modes agree on it.
 */
export async function readVisibility(
  github: string,
): Promise<"public" | "restricted"> {
  return githubProvider(github).visibility();
}

/** Collect facts for one repository through a provider. */
export async function collectRepo(slug: string, provider: any) {
  const notes: string[] = [];
  const { files, capped, unexamined, truncated } =
    await selectManifests(provider);

  if (truncated) {
    notes.push(
      "file listing was truncated by the API — this scan is incomplete",
    );
  }
  for (const dir of capped) {
    notes.push(`${dir}: holds a manifest below the depth cap (${MAX_DEPTH})`);
  }

  const read = await mapLimit(files, 6, async (file: any) => {
    let text: string;
    try {
      text = await provider.read(file.path);
    } catch (error) {
      notes.push(
        `${file.path}: unreadable (${(error as any).code ?? (error as Error).message})`,
      );
      return null;
    }
    try {
      let facts;
      if (file.format === "version-pin") {
        facts = extractVersionPin(file.path.split("/").pop(), text);
        if (!facts) return null;
      } else {
        facts = (EXTRACT as Record<string, (t: string) => unknown>)[
          file.format
        ]!(text);
      }
      return {
        repo: slug,
        path: file.path,
        // The content address of the exact bytes parsed. Null only when the
        // provider could not produce one, which is itself worth seeing rather
        // than papering over with a placeholder.
        blob: (await provider.blobSha?.(file.path)) ?? null,
        format: file.format,
        facts,
      };
    } catch (error) {
      // A manifest that will not parse is a finding, not a reason to emit a
      // quietly smaller graph.
      notes.push(
        `${file.path}: ${file.format} parse failed — ${(error as Error).message}`,
      );
      return null;
    }
  });

  return {
    sources: read
      .filter(Boolean)
      .sort((a: any, b: any) => (a.path < b.path ? -1 : 1)),
    notes: notes.sort(),
    // Root configs a known-unparsed format claims. Carried to the lock so the
    // gap reaches a consumer: a note printed at collect time and then dropped
    // is invisible to everyone who reads the artifact.
    unexamined,
  };
}

/**
 * Collect the whole roster into a lock document.
 *
 * @param {Array} roster from roster.ts
 * @param {{remote?: boolean}} options `remote` reads GitHub default branches
 *        instead of local checkouts — the mode the freshness gate runs in.
 * @returns {Promise<{lock: object, report: object}>}
 */
/**
 * The bytes an external attestor signs: the lock with `collected_at` removed.
 *
 * The timestamp is the only thing that legitimately differs between two
 * collections of identical upstream state, so it cannot be part of the claim
 * "this is what the ecosystem declared" — otherwise every re-collection would
 * look like a change and `deps:verify` would be permanently red, which is the
 * loudest possible way to make a gate ignored.
 *
 * Everything else IS part of the claim, including each source's `blob`. That
 * is what makes the attestation about specific bytes rather than about a file
 * path that may since have moved.
 */
export function canonicalLockBytes(lock: any): string {
  const { collected_at, ...rest } = lock;
  return JSON.stringify(rest, null, 2) + "\n";
}

/** sha256 of the canonical bytes — the digest an attestor commits to. */
export function canonicalLockDigest(lock: any): string {
  return (
    "sha256:" +
    createHash("sha256").update(canonicalLockBytes(lock), "utf8").digest("hex")
  );
}

export async function collect(
  roster: any[],
  {
    remote = false,
    includePrivate = false,
    token,
  }: { remote?: boolean; includePrivate?: boolean; token?: string } = {},
) {
  const collectedAt = new Date().toISOString();
  let sawPrivate = false;
  const repos: any[] = [];
  const sources: any[] = [];
  const report: { read: string[]; skipped: string[]; notes: string[] } = {
    read: [],
    skipped: [],
    notes: [],
  };

  for (const entry of roster) {
    // One provider per repository, reused: it caches the single API request
    // that both lists the files and establishes visibility.
    const upstream = githubProvider(entry.github);
    const visibility = await upstream.visibility();
    const record = {
      slug: entry.slug,
      github: entry.github,
      visibility,
      on_map: entry.onMap,
      read: false,
      unexamined: [] as string[],
    };

    if (visibility !== "public") {
      // `visibility` stays `restricted` either way — it is what the PUBLIC
      // sees, and it is what redaction keys on. Reading the repository does
      // not make it public, and conflating those is 0day-ec78cb.
      if (!includePrivate || !token) {
        report.skipped.push(
          `${entry.slug}: restricted — not read; nameable as an edge endpoint only`,
        );
        repos.push(record);
        continue;
      }
      let result: Awaited<ReturnType<typeof collectRepo>>;
      try {
        result = await collectRepo(
          entry.slug,
          privateProvider(entry.github, token),
        );
      } catch (error) {
        report.skipped.push(
          `${entry.slug}: restricted, and reading it with a credential failed — ${(error as Error).message}`,
        );
        repos.push(record);
        continue;
      }
      sawPrivate = true;
      record.read = true;
      record.unexamined = result.unexamined;
      repos.push(record);
      sources.push(...result.sources);
      report.read.push(
        `${entry.slug}: ${result.sources.length} manifests from ${entry.github} (PRIVATE, with credential)`,
      );
      for (const note of result.notes) {
        report.notes.push(`${entry.slug}/${note}`);
      }
      continue;
    }

    const provider = remote
      ? upstream
      : entry.checkout
        ? localProvider(entry.checkout)
        : null;

    if (!provider) {
      report.skipped.push(
        `${entry.slug}: public but no local checkout found — no facts collected ` +
          "(use --remote to read it from GitHub)",
      );
      repos.push(record);
      continue;
    }

    let result: Awaited<ReturnType<typeof collectRepo>>;
    try {
      result = await collectRepo(entry.slug, provider);
    } catch (error) {
      report.skipped.push(
        `${entry.slug}: collection failed against ${provider.describe()} — ${(error as Error).message}`,
      );
      repos.push(record);
      continue;
    }

    record.read = true;
    record.unexamined = result.unexamined;
    repos.push(record);
    sources.push(...result.sources);
    report.read.push(
      `${entry.slug}: ${result.sources.length} manifests from ${provider.describe()}`,
    );
    for (const note of result.notes) report.notes.push(`${entry.slug}/${note}`);
  }

  const lock = {
    schema_version: LOCK_SCHEMA_VERSION,
    // Read once, not per-source, so every entry in one collection shares a
    // single observation time rather than smearing across the run.
    collected_at: collectedAt,
    // Marks a lock that contains manifests from repositories the public cannot
    // read. Such a lock must never become the committed artifact, and the CLI
    // refuses to write it to the published paths.
    private_inclusive: sawPrivate,
    note: "Generated by `task deps:update`. Normalized declarations read from each public repository's own manifests, each carrying the git blob SHA of the file parsed. Do not edit by hand — `task deps:check` fails when data/graph.json stops being this file's derivation, and `task deps:verify` fails when this file stops matching the repositories. `collected_at` is the only field that differs between two collections of identical upstream state; `task deps:canonical` prints the bytes without it, which is what an external attestor signs.",
    repos: repos.sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    sources: sources.sort((a, b) =>
      a.repo + "/" + a.path < b.repo + "/" + b.path ? -1 : 1,
    ),
  };

  return { lock, report };
}
