import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const packages = [
  "@agentic-research/depgraph-core",
  "@agentic-research/depgraph-collect",
];

export function validatePackageContents(packageName, files) {
  if (!files.includes("README.md")) {
    throw new Error(
      `${packageName}: generated README.md is missing from the tarball`,
    );
  }
  const mdxSources = files.filter((file) => file.endsWith(".mdx"));
  if (mdxSources.length > 0) {
    throw new Error(
      `${packageName}: MDX source must not be published: ${mdxSources.join(", ")}`,
    );
  }
}

function packageFiles(root, packageName) {
  const output = execFileSync(
    "pnpm",
    ["--filter", packageName, "pack", "--json", "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  const manifest = JSON.parse(output.slice(output.indexOf("{")));
  return manifest.files.map((file) => file.path);
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  for (const packageName of packages) {
    validatePackageContents(packageName, packageFiles(root, packageName));
  }
}

if (import.meta.main) main();
