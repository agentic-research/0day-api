/**
 * Source providers — where a repository's manifests are read from.
 *
 * Two backends, one selection rule. `local` reads a sibling checkout: fast, and
 * what you want while iterating. `github` reads the default branch through the
 * API: slower, but it is the only one that can run where the ecosystem is not
 * checked out, which is what lets the freshness gate run in CI instead of
 * depending on somebody remembering to refresh the lock by hand.
 *
 * Both must select exactly the same files from the same repository, or the two
 * modes would produce different locks and comparing them would be meaningless.
 * That is why the filter lives here once and is applied to both.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Directories never descended into: build output, vendored code, fixtures. */
export const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "testdata",
  "fixtures",
  "out",
  "coverage",
]);

/** How deep below the repository root nested manifests are searched. */
export const MAX_DEPTH = 4;

export const RECURSIVE_MANIFESTS = new Map([
  ["Cargo.toml", "cargo"],
  ["go.mod", "gomod"],
  ["package.json", "npm"],
]);

export const ROOT_ONLY_MANIFESTS = new Map([
  ["server.json", "server-json"],
  ["cluster.toml", "cluster-toml"],
  ["cluster.lock.toml", "cluster-lock"],
  ["Taskfile.yml", "taskfile"],
]);

const VERSION_PIN = /^\.[a-z0-9][a-z0-9-]*-version$/;

/** Exactly `.github/workflows/<file>` — no nesting, no other dot-directory. */
const WORKFLOW_DIR = /^\.github\/workflows\/[^/]+$/;

/**
 * Decide whether a repo-relative path is a manifest this graph reads, and in
 * what format. Returns null when it is not.
 *
 * @param {string} relPath forward-slash separated, relative to the repo root
 * @returns {{format: string, depth: number}|null}
 */
export function classify(
  relPath: string,
): { format: string; depth: number } | null {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const depth = dirs.length;

  // GitHub Actions workflows are the one thing read from a dot-directory, and
  // the allowance is written as an exact path rather than by opening dot-dirs
  // generally: `.github/workflows/` and nothing else. A workflow declares
  // cross-repository event edges (`repository_dispatch`) that exist in no
  // package manifest, which is why it is worth the exception.
  if (WORKFLOW_DIR.test(relPath) && /\.ya?ml$/.test(base)) {
    return { format: "workflow", depth };
  }

  for (const dir of dirs) {
    if (SKIP_DIRS.has(dir) || dir.startsWith(".")) return null;
  }
  if (depth > MAX_DEPTH) return null;

  const recursive = RECURSIVE_MANIFESTS.get(base);
  if (recursive) return { format: recursive, depth };

  if (depth === 0) {
    const rootOnly = ROOT_ONLY_MANIFESTS.get(base);
    if (rootOnly) return { format: rootOnly, depth };
    if (VERSION_PIN.test(base)) return { format: "version-pin", depth };
  }
  return null;
}

/**
 * A root-level config file this collector SAW and has no parser for.
 *
 * `unresolved` records a declaration that was parsed and resolved to nothing.
 * A declaration written in a format with no parser never gets that far —
 * `classify()` returns null, nothing is attempted, nothing fails, and the
 * coupling is absent rather than recorded. That gap was silence, and silence
 * is indistinguishable from "there was nothing there" (0day-11da43).
 *
 * The real case: canonical-hours declares a coupling to vigil in a root
 * `.vigil.toml`. Nothing here parses it, so the edge did not appear anywhere —
 * not in `edges`, not in `weak_edges`, and not in `unresolved`.
 *
 * ── Authored, not pattern-matched ────────────────────────────────────────
 *
 * The first version of this tested filenames against a regex for "things that
 * look like config": root dotfiles with a `.toml`/`.json`/`.yaml` extension.
 * That is a heuristic, and it fails in both directions at once. It reported
 * `.prettierrc.json` — which declares no coupling to anything — with exactly
 * the same weight as `.vigil.toml`, so a reader could not tell a real gap from
 * formatting config. And it would still have missed any declaration whose
 * filename did not happen to match, while looking exhaustive.
 *
 * A guess dressed as a finding is worse than silence, because silence at least
 * does not claim to have looked.
 *
 * So membership here is AUTHORED, in the same class as a project's status:
 * someone states "this format declares couplings and we do not parse it". That
 * is a judgment a person makes and a filename cannot imply. Exact lookup, no
 * pattern.
 *
 * The honest cost, stated rather than hidden: a format nobody has written down
 * stays invisible. That is a smaller and more truthful claim than a regex
 * pretending to generality it never had — and unlike the regex, the fix is
 * obvious and bounded when a miss turns up: add the line.
 */
export const UNPARSED_FORMATS = new Map<string, string>([
  [
    ".vigil.toml",
    "vigil watch — declares the repositories and beads this repo is watched against",
  ],
  [
    "compatibility.json",
    "a declared interoperability range — the schema and wire versions a consumer must be within to talk to this repository's artifacts",
  ],
]);

/**
 * Root-level files that a known-unparsed format claims, and this collector
 * therefore saw without examining.
 *
 * `classify()` is consulted first so the two can never disagree: the moment a
 * parser is added for one of these, it stops appearing here. A list that did
 * not shrink when coverage grew would become a stale complaint rather than a
 * live statement about what was read.
 */
export function unexaminedConfigs(allPaths: string[]): string[] {
  const seen = new Set<string>();
  for (const relPath of allPaths) {
    // Root level only: a nested config belongs to a subproject, and this is a
    // statement about what the REPOSITORY declares.
    if (relPath.includes("/")) continue;
    if (!UNPARSED_FORMATS.has(relPath)) continue;
    // Parsed is not unexamined.
    if (classify(relPath)) continue;
    seen.add(relPath);
  }
  return [...seen].sort();
}

/**
 * Directories that were not searched because of the depth cap but do hold a
 * manifest — a real coverage gap, as opposed to the hundreds of leaf
 * directories that were never going to matter.
 */
function cappedWithManifest(allPaths: string[]): string[] {
  const capped = new Set<string>();
  for (const relPath of allPaths) {
    const segments = relPath.split("/");
    const base = segments[segments.length - 1];
    if (!RECURSIVE_MANIFESTS.has(base)) continue;
    const dirs = segments.slice(0, -1);
    if (dirs.length <= MAX_DEPTH) continue;
    if (dirs.some((d) => SKIP_DIRS.has(d) || d.startsWith("."))) continue;
    capped.add(dirs.join("/"));
  }
  return [...capped].sort() as string[];
}

async function walkLocal(
  root: string,
  dir: string,
  acc: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      // `.github` is descended into so the local provider can see workflows.
      // Without this the two providers would disagree about which files exist —
      // the remote tree listing already contains them — and this module's whole
      // contract is that both select identically or the two lock modes stop
      // being comparable.
      const isWorkflowPath = rel === ".github" || rel === ".github/workflows";
      if (
        !isWorkflowPath &&
        (SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))
      ) {
        continue;
      }
      // One level past the cap, so a capped directory holding a manifest can
      // still be reported rather than silently vanishing.
      if (rel.split("/").length > MAX_DEPTH + 1) continue;
      await walkLocal(root, full, acc);
      continue;
    }
    if (entry.isFile()) acc.push(rel);
  }
}

/**
 * The git blob SHA of some bytes: `sha1("blob " + byteLength + "\0" + bytes)`.
 *
 * Computed rather than shelled out to `git hash-object`, so it works on a
 * directory that is not a git repository at all, and so this module keeps its
 * no-subprocess property. Byte length, not character length — a manifest with
 * any non-ASCII in it would otherwise disagree with GitHub by a few bytes and
 * the two providers would silently stop matching.
 */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

/** Read manifests from a checkout on disk. */
export function localProvider(checkout: string) {
  return {
    kind: "local",
    describe: () => checkout,
    async listPaths() {
      const all: string[] = [];
      await walkLocal(checkout, checkout, all);
      return { all: all.sort(), truncated: false };
    },
    // The same value GitHub reports for the same bytes. That equality is the
    // point: it is what lets a lock collected locally and one collected
    // remotely be compared at all.
    async blobSha(relPath: string) {
      try {
        return gitBlobSha(await readFile(path.join(checkout, relPath)));
      } catch {
        return null;
      }
    },
    async read(relPath: string) {
      return readFile(path.join(checkout, relPath), "utf8");
    },
  };
}

/**
 * Read a repository from GitHub without credentials.
 *
 * No token, in CI or anywhere else. That is a design constraint, not a
 * convenience: a graph whose contents depend on who authenticated is not
 * reproducible by anyone else, and a scheduled job holding a credential is a
 * standing liability for a repository whose entire output is public facts.
 *
 * It costs exactly ONE API request per repository — the recursive tree
 * listing — and that request does two jobs at once: it enumerates the files,
 * and its status code establishes visibility (200 public, anything else
 * restricted). File contents then come from raw.githubusercontent.com, which
 * is a CDN and spends no API quota. Fourteen repositories is fourteen requests
 * against the unauthenticated limit of sixty an hour.
 *
 * ── Why there is no token support, and why removing it was a fix ──────────
 *
 * This block used to end by saying a token "is used if present, purely to
 * raise that limit … the output is identical either way", while the paragraph
 * above it said "no token, in CI or anywhere else". Both could not be true,
 * and the second one was the code (0day-ec78cb).
 *
 * The output was NOT identical either way. Because the tree listing doubles as
 * the visibility probe — visibility is "did this 404" — a token that can see a
 * private repository turns that 404 into a 200. Running with a token recorded
 * `ley-line`, `rig` and `vigil` (all private) as `visibility: "public"`,
 * `read: true`, and grew the graph from 8 entities to 11.
 *
 * That field is what `redact()` keys on and what `privacyViolations()` audits,
 * so every rail agreed with itself while being wrong. No gate can catch it: the
 * bad value enters upstream of every check.
 *
 * The token bought exactly one thing — a higher rate limit on this one call —
 * and that is the call that must stay unauthenticated. There was nothing left
 * for it to do, so it is gone rather than guarded. A guard can be removed by
 * someone who wants their local iteration to go faster; an absent code path
 * cannot.
 */
const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

/**
 * Identifies this tool to GitHub, which rejects API requests that send no
 * `User-Agent`.
 *
 * Names the package rather than any one deployment. The previous value was
 * `0day-dependency-graph`, which was accurate while this code lived in that
 * repository and became a lie the moment anyone else ran it. Pass your own to
 * {@link apiHeaders} if you would rather be identifiable in GitHub's logs as
 * yourself — which is the polite thing to do when running at any volume.
 */
export const USER_AGENT = "depgraph-collect";

/**
 * Headers for every api.github.com request. Deliberately carries no
 * `Authorization`, and reads no environment variable, so what this tool
 * observes cannot depend on who ran it.
 *
 * Exported so a test can assert the absence directly. The property is
 * unobservable from the outside without a private repository and a credential
 * to see it with, and a test that needs those is a test nobody runs.
 */
export function apiHeaders(
  userAgent: string = USER_AGENT,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function githubProvider(github: string) {
  let tree: {
    visibility: "public" | "restricted";
    all: string[];
    truncated: boolean;
  } | null = null;
  const blobShas = new Map<string, string>();

  const loadTree = async () => {
    if (tree) return tree;
    const response = await fetch(
      `${GITHUB_API}/repos/${github}/git/trees/HEAD?recursive=1`,
      { headers: apiHeaders() },
    );
    if (response.status === 404) {
      // Covers private, renamed and nonexistent alike. All three mean the same
      // thing here: not established as public, so do not read it.
      tree = { visibility: "restricted", all: [], truncated: false };
      return tree;
    }
    if (!response.ok) {
      // A rate limit or an outage must not read as "this repository is
      // private" — that would silently shrink the graph and call it complete.
      throw new Error(
        `GET /repos/${github}/git/trees/HEAD → ${response.status} ${response.statusText}` +
          (response.headers.get("x-ratelimit-remaining") === "0"
            ? // Deliberately does NOT suggest a token. This request is the
              // visibility probe, and authenticating it is what let private
              // repositories be recorded as public (0day-ec78cb). Waiting is the
              // correct advice; the limit resets hourly.
              " (unauthenticated rate limit exhausted — wait for the hourly reset; a token must NOT be used here, see 0day-ec78cb)"
            : ""),
      );
    }
    // `Response.json()` is `unknown` here, which is honest — it is whatever the
    // server sent. The shape we depend on is named once, so the assumption
    // about GitHub's tree API is written down rather than re-asserted by a cast
    // at each use.
    const body = (await response.json()) as {
      tree?: { type?: string; sha?: string; path: string }[];
      truncated?: boolean;
    };
    // The tree listing already carries a git blob SHA per file and this used to
    // throw it away. It is the content address of the manifest actually read —
    // free here, because it rides the one request already being made.
    for (const node of body.tree ?? []) {
      if (node.type === "blob" && node.sha) blobShas.set(node.path, node.sha);
    }
    tree = {
      visibility: "public",
      all: (body.tree ?? [])
        .filter((node: any) => node.type === "blob")
        .map((node: any) => node.path)
        .sort(),
      // A truncated tree means the listing is incomplete. Say so rather than
      // letting a partial scan read as a complete one.
      truncated: Boolean(body.truncated),
    };
    return tree;
  };

  return {
    kind: "github",
    describe: () => `${github} (default branch)`,
    async visibility() {
      return (await loadTree()).visibility;
    },
    async listPaths() {
      const loaded = await loadTree();
      return { all: loaded.all, truncated: loaded.truncated };
    },
    async blobSha(relPath: string) {
      await loadTree();
      return blobShas.get(relPath) ?? null;
    },
    async read(relPath: string) {
      const encoded = relPath.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${GITHUB_RAW}/${github}/HEAD/${encoded}`, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return response.text();
    },
  };
}

/**
 * Read a repository WITH a credential — for a private repository the operator
 * has access to and deliberately asked for (`--include-private`).
 *
 * ── The credential never touches visibility ──────────────────────────────
 *
 * `repo_visibility` still comes from `githubProvider(...).visibility()`, which
 * is unauthenticated by construction. That field is what `redact()` keys on and
 * what `privacyViolations()` audits, so it has to mean "what the public sees"
 * regardless of who ran the collection. Authenticating it is what recorded
 * three private repositories as public (0day-ec78cb), and this function exists
 * precisely so that reading private content no longer requires doing so.
 *
 * A private repository therefore stays `restricted` in the lock AND is read.
 * Those are not in tension: one is a fact about the world, the other a fact
 * about this run.
 *
 * ── Contents API, not raw ────────────────────────────────────────────────
 *
 * `raw.githubusercontent.com` takes no credential, which is why the earlier
 * token support could never actually read a private file — the tree listing
 * succeeded and every body 404'd. Private bodies come from the contents API,
 * base64-decoded.
 */
export function privateProvider(github: string, token: string) {
  const headers = { ...apiHeaders(), Authorization: `Bearer ${token}` };
  let tree: { all: string[]; truncated: boolean } | null = null;
  const blobShas = new Map<string, string>();

  const loadTree = async () => {
    if (tree) return tree;
    const response = await fetch(
      `${GITHUB_API}/repos/${github}/git/trees/HEAD?recursive=1`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(
        `GET /repos/${github}/git/trees/HEAD → ${response.status} ${response.statusText}` +
          " (with credential — check the token's scope for this repository)",
      );
    }
    const body: any = await response.json();
    for (const node of body.tree ?? []) {
      if (node.type === "blob" && node.sha) blobShas.set(node.path, node.sha);
    }
    tree = {
      all: (body.tree ?? [])
        .filter((n: any) => n.type === "blob")
        .map((n: any) => n.path)
        .sort(),
      truncated: Boolean(body.truncated),
    };
    return tree;
  };

  return {
    kind: "github-private",
    describe: () => `${github} (default branch, with credential)`,
    async listPaths() {
      return loadTree();
    },
    async blobSha(relPath: string) {
      await loadTree();
      return blobShas.get(relPath) ?? null;
    },
    async read(relPath: string) {
      const encoded = relPath.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(
        `${GITHUB_API}/repos/${github}/contents/${encoded}`,
        { headers },
      );
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body: any = await response.json();
      if (typeof body.content !== "string") {
        throw new Error("contents API returned no inline content");
      }
      return Buffer.from(body.content, "base64").toString("utf8");
    },
  };
}

/**
 * Select the manifests to read from a provider's full file listing.
 *
 * @returns {Promise<{files: Array<{path: string, format: string}>, capped: string[], truncated: boolean}>}
 */
export async function selectManifests(provider: any) {
  const { all, truncated } = await provider.listPaths();
  const files: { path: string; format: string }[] = [];
  for (const relPath of all) {
    const hit = classify(relPath);
    if (hit) files.push({ path: relPath, format: hit.format });
  }
  return {
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    capped: cappedWithManifest(all),
    unexamined: unexaminedConfigs(all),
    truncated,
  };
}

/** Map with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index], index);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}
