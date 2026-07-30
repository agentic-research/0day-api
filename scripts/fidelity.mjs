/**
 * Does this package still reproduce the reference deployment's artifact?
 *
 * 〇.day publishes a map derived by the code these packages were extracted
 * from. If the extraction — or any later change — altered behaviour, the
 * derivation stops matching, and this is where that shows up. It is the
 * strongest test available: a real lock, a real committed artifact, and a
 * byte-for-byte comparison rather than a shape assertion.
 *
 * Needs a 0day checkout. Skips LOUDLY without one rather than passing, because
 * a fidelity check that silently succeeds when it compared nothing is the exact
 * failure this whole project argues against.
 *
 *   REFERENCE_CHECKOUT=/path/to/0day node scripts/fidelity.mjs
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { derive, checkGraph } from "../packages/core/dist/index.js";

const ORIGIN = "https://xn--w6j.day";

const candidates = [
  process.env.REFERENCE_CHECKOUT,
  path.join(homedir(), "remotes/art/0day"),
  path.join(homedir(), "github/art/0day"),
].filter(Boolean);

const root = candidates.find(
  (dir) => dir && existsSync(path.join(dir, "data/graph.json")),
);

if (!root) {
  console.error("SKIP: no reference checkout found. Looked in:");
  for (const dir of candidates) console.error(`  ${dir}`);
  console.error(
    "\nThis check did NOT run. Set REFERENCE_CHECKOUT to a 0day checkout to run it.",
  );
  process.exit(0);
}

const lockText = await readFile(
  path.join(root, "data/sources.lock.json"),
  "utf8",
);
const graphText = await readFile(path.join(root, "data/graph.json"), "utf8");

// The authored half. Loaded by transpiling the reference deployment's own
// manifest, because that is where ITS membership lives — the packages
// deliberately do not know how to find such a file, which is the point of the
// roster being supplied rather than discovered.
const ts = (await import("typescript")).default;
const projectsPath = path.join(root, "src/data/projects.ts");
const { outputText } = ts.transpileModule(
  await readFile(projectsPath, "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: projectsPath,
  },
);
const { projects } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputText, "utf8").toString("base64")
);

const produced =
  JSON.stringify(
    derive(JSON.parse(lockText), projects, { origin: ORIGIN }),
    null,
    2,
  ) + "\n";

if (produced !== graphText) {
  const a = graphText.split("\n");
  const b = produced.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    console.error(
      `FAIL: derivation diverged from ${root}/data/graph.json at line ${i + 1}`,
    );
    console.error(`  committed: ${a[i] ?? "<end of file>"}`);
    console.error(`  produced : ${b[i] ?? "<end of file>"}`);
    break;
  }
  process.exit(1);
}

const result = checkGraph({ lockText, graphText, projects, origin: ORIGIN });
if (!result.ok) {
  console.error(
    `FAIL: the packaged gate rejected the reference artifact (${result.reason})`,
  );
  console.error(result.message);
  process.exit(1);
}

console.log(
  `fidelity ok — reproduced ${root}/data/graph.json byte-for-byte ` +
    `(${graphText.length} bytes); packaged gate agrees: ${result.message}`,
);
