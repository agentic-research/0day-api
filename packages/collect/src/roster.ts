/**
 * Roster — which repositories the map may name, and where their checkouts are.
 *
 * Membership is an **authored judgment**, in the same class as a project's
 * status: someone decides that a repository is part of this ecosystem. It is
 * therefore the caller's to supply, and this package deliberately does not
 * discover it.
 *
 * The version of this file inside 0day did discover it — it transpiled that
 * repository's `src/data/projects.ts` and read a sibling `extra-repos.json`,
 * and its default search roots were one machine's home directory. All three
 * are facts about one deployment, and a package that assumed them would work
 * for exactly one user while appearing general.
 *
 * So the boundary is: you build a `RosterEntry[]` however your project already
 * records membership — a manifest, a config file, a directory listing, an API
 * call — and hand it over. What this module offers is only the part that is
 * genuinely shared: locating checkouts on disk, and doing it deterministically.
 *
 * Visibility is NOT here, and is not authored anywhere. It is read at collect
 * time and fails closed: a repository whose visibility cannot be established is
 * treated as private, so its manifests are never read and any edge touching it
 * carries no detail.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** One repository the map is allowed to name. */
export interface RosterEntry {
  /** Stable identifier used as the entity id and as a checkout directory name. */
  slug: string;
  /** GitHub owner, e.g. `agentic-research`. */
  owner: string;
  /** GitHub repository name, which may differ from `slug`. */
  repo: string;
  /** `owner/repo`. */
  github: string;
  /**
   * Whether this repository is a first-class member of the published map, as
   * opposed to one that may legitimately appear only as an edge endpoint.
   */
  onMap: boolean;
  /** Absolute path to a local checkout, or null when none was found. */
  checkout: string | null;
}

/** Expand a leading `~/` against the current user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

/**
 * First existing checkout for `name` under `roots`, in order.
 *
 * Order is significant and is the caller's: the first root that contains a
 * `.git` wins, so precedence is stated rather than discovered.
 */
export function findCheckout(name: string, roots: string[]): string | null {
  for (const root of roots) {
    const candidate = path.join(expandHome(root), name);
    if (existsSync(path.join(candidate, ".git"))) return candidate;
  }
  return null;
}

/**
 * Fill in `checkout` for each entry, and sort by slug.
 *
 * Sorted because everything downstream is compared byte-for-byte against a
 * committed artifact; an unstable order would make the gate fail for reasons
 * that have nothing to do with the sources.
 *
 * A repository's directory name and its repository name can differ, so both are
 * tried — `slug` first, since that is what the map calls it.
 */
export function resolveCheckouts(
  roster: readonly RosterEntry[],
  roots: readonly string[],
): RosterEntry[] {
  return [...roster]
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((entry) => ({
      ...entry,
      checkout:
        findCheckout(entry.slug, [...roots]) ??
        findCheckout(entry.repo, [...roots]),
    }));
}

/**
 * Parse a `PATH`-style list of search roots.
 *
 * Offered because reading roots from the environment is a common need, not
 * because this package decides which variable to read — the caller passes the
 * value. There is no default root: a package cannot know where someone keeps
 * their checkouts, and guessing would silently find the wrong repository.
 */
export function parseRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a roster entry from an `owner/repo` string.
 *
 * Throws rather than returning null: a malformed coordinate is a mistake in
 * authored membership, and a roster that silently drops entries produces a map
 * that is missing repositories with nothing recording why.
 */
export function entryFromGithub(
  github: string,
  { slug, onMap = true }: { slug?: string; onMap?: boolean } = {},
): RosterEntry {
  const parts = github.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `roster entry must be "owner/repo", got ${JSON.stringify(github)}`,
    );
  }
  const [owner, repo] = parts as [string, string];
  return {
    slug: slug ?? repo,
    owner,
    repo,
    github: `${owner}/${repo}`,
    onMap,
    checkout: null,
  };
}
