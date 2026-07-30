import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkStringify, { bullet: "-", emphasis: "_" });

const unsupportedMdxNodeTypes = new Set([
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxjsEsm",
  "mdxJsxFlowElement",
  "mdxJsxTextElement",
]);

const documents = [
  {
    path: "README.mdx",
    required: ["title", "summary"],
  },
  {
    path: "packages/core/docs/readme.mdx",
    outputPath: "packages/core/README.md",
    required: ["title", "summary", "package", "runtime"],
  },
  {
    path: "packages/collect/docs/readme.mdx",
    outputPath: "packages/collect/README.md",
    required: ["title", "summary", "package", "runtime"],
  },
];

function findUnsupportedMdx(tree) {
  const pending = [tree];

  while (pending.length > 0) {
    const node = pending.pop();
    if (unsupportedMdxNodeTypes.has(node.type)) return node.type;
    if (node.children) pending.push(...node.children);
  }

  return null;
}

export async function renderReadme(source, descriptor) {
  const tree = processor.parse(source);
  const frontmatter = tree.children[0];

  if (frontmatter?.type !== "yaml") {
    throw new Error(`${descriptor.path}: YAML frontmatter is required`);
  }

  const metadata = parseYaml(frontmatter.value);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${descriptor.path}: frontmatter must be a YAML mapping`);
  }

  for (const key of descriptor.required) {
    if (typeof metadata[key] !== "string" || metadata[key].trim() === "") {
      throw new Error(`${descriptor.path}: frontmatter requires ${key}`);
    }
  }

  const unsupported = findUnsupportedMdx(tree);
  if (unsupported) {
    throw new Error(
      `${descriptor.path}: unsupported MDX (${unsupported}); README output must render on GitHub and npm`,
    );
  }

  tree.children.shift();
  return String(processor.stringify(tree));
}

export function selectDocuments(documents, requested) {
  const selected = documents.filter(
    (document) => requested.size === 0 || requested.has(document.path),
  );
  if (requested.size > 0 && selected.length !== requested.size) {
    const known = new Set(selected.map((document) => document.path));
    const unknown = [...requested].filter((path) => !known.has(path));
    throw new Error(`unknown README source: ${unknown.join(", ")}`);
  }
  return selected;
}

export function outputPathFor(descriptor) {
  return descriptor.outputPath ?? descriptor.path.replace(/\.mdx$/, ".md");
}

async function renderDocument(root, descriptor) {
  const sourcePath = resolve(root, descriptor.path);
  return {
    outputPath: resolve(root, outputPathFor(descriptor)),
    text: await renderReadme(await readFile(sourcePath, "utf8"), descriptor),
  };
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const check = process.argv.includes("--check");
  const requested = new Set(
    process.argv.filter((argument) => argument.endsWith(".mdx")),
  );
  const selected = selectDocuments(documents, requested);
  const rendered = await Promise.all(
    selected.map((document) => renderDocument(root, document)),
  );
  const stale = [];

  for (const { outputPath, text } of rendered) {
    if (check) {
      let existing = "";
      try {
        existing = await readFile(outputPath, "utf8");
      } catch {
        stale.push(relative(root, outputPath));
        continue;
      }
      if (existing !== text) stale.push(relative(root, outputPath));
      continue;
    }
    await writeFile(outputPath, text);
  }

  if (stale.length > 0) {
    throw new Error(
      `README output is stale: ${stale.join(", ")}; run pnpm readmes`,
    );
  }
}

if (import.meta.main) await main();
