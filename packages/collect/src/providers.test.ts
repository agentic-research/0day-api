/**
 * The seen-but-unexamined mechanism.
 *
 * This package's `test` script was `import('./dist/index.js')` and a log line —
 * it proved the module loads and nothing else, so it passed under any behaviour
 * the collector could have. These are the first tests that can fail.
 *
 * Every case here carries a control: an assertion that the same machinery
 * declines to fire on an input it should not. A test that only ever confirms
 * the positive cannot distinguish working code from code that says yes to
 * everything, which is the defect this file exists to stop repeating.
 */
import { describe, expect, test } from "vitest";
import { UNPARSED_FORMATS, classify, unexaminedConfigs } from "./providers.js";

describe("unexaminedConfigs", () => {
  test("reports a root-level file whose format is declared unparsed", () => {
    expect(unexaminedConfigs(["compatibility.json"])).toEqual([
      "compatibility.json",
    ]);
    expect(unexaminedConfigs([".vigil.toml"])).toEqual([".vigil.toml"]);
  });

  test("stays silent on a file nobody declared — the control", () => {
    // If this returned anything, the positive case above would prove nothing:
    // a function that reported every path would pass it.
    expect(unexaminedConfigs(["README.md", "LICENSE", "src/main.rs"])).toEqual(
      [],
    );
  });

  test("ignores a nested copy, because the claim is about the repository", () => {
    // A compatibility surface inside a subdirectory belongs to a subproject and
    // says nothing about what the repository as a whole declares.
    expect(unexaminedConfigs(["vendor/dep/compatibility.json"])).toEqual([]);
    expect(unexaminedConfigs(["a/b/.vigil.toml"])).toEqual([]);

    // HONESTY NOTE, found by mutating the implementation rather than by reading
    // it: this pins the BEHAVIOUR, not the `relPath.includes("/")` guard that
    // appears to cause it. Deleting that guard leaves every test here passing,
    // because the table is keyed by bare filename and an exact lookup can never
    // match a path containing a separator. The guard is belt-and-braces.
    //
    // It earns its place the moment lookup stops being exact — a basename match
    // added for convenience would silently start reporting subproject configs
    // as repository-level declarations. Stated so the next reader does not
    // mistake this test for proof that the guard is load-bearing today.
  });

  test("deduplicates and sorts, so the lock does not churn on tree order", () => {
    const forward = unexaminedConfigs([
      "compatibility.json",
      ".vigil.toml",
      "compatibility.json",
    ]);
    const reversed = unexaminedConfigs(
      ["compatibility.json", ".vigil.toml"].reverse(),
    );
    expect(forward).toEqual([".vigil.toml", "compatibility.json"]);
    // Same set, different input order, same output. Collection order must not
    // reach the committed artifact, or `deps:check` fails on noise.
    expect(reversed).toEqual(forward);
  });

  /**
   * The invariant that protects future edits to the table.
   *
   * `unexaminedConfigs` consults `classify()` first so a format cannot be both
   * parsed and reported unexamined. Nothing stops someone adding a parser for a
   * listed format and leaving the entry behind — at which point the map would
   * claim it had not looked at something it reads. This asserts the two tables
   * cannot drift apart, rather than trusting whoever edits next to remember.
   */
  test("no declared-unparsed format is also parsed", () => {
    expect(UNPARSED_FORMATS.size).toBeGreaterThan(0);
    for (const name of UNPARSED_FORMATS.keys()) {
      expect(
        classify(name),
        `${name} is listed as unparsed but classify() parses it — remove the UNPARSED_FORMATS entry when a parser lands`,
      ).toBeFalsy();
      // And it must still be reported, which is the other half: a listed format
      // that classify() ignores has to actually reach the lock.
      expect(unexaminedConfigs([name])).toEqual([name]);
    }
  });
});
