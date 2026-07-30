import assert from "node:assert/strict";
import test from "node:test";

import { renderReadme, selectDocuments } from "./readmes.mjs";

const root = {
  path: "README.mdx",
  required: ["title", "summary"],
};

test("renders Markdown body after validating and removing frontmatter", async () => {
  assert.equal(
    await renderReadme(
      "---\ntitle: Example\nsummary: A test document\n---\n\n# Hello\n",
      root,
    ),
    "# Hello\n",
  );
});

test("uses the repository's canonical Markdown markers", async () => {
  assert.equal(
    await renderReadme(
      "---\ntitle: Example\nsummary: A test document\n---\n\n*emphasis*\n\n* first\n* second\n",
      root,
    ),
    "_emphasis_\n\n- first\n- second\n",
  );
});

test("rejects a source without frontmatter", async () => {
  await assert.rejects(() => renderReadme("# Hello\n", root), /frontmatter/);
});

test("rejects MDX-only syntax that would not render on GitHub or npm", async () => {
  await assert.rejects(
    () =>
      renderReadme(
        "---\ntitle: Example\nsummary: A test document\n---\n\n<Component />\n",
        root,
      ),
    /unsupported MDX/i,
  );
});

test("selects every README when no source path is selected", () => {
  const documents = [
    { path: "README.mdx" },
    { path: "packages/core/README.mdx" },
  ];

  assert.deepEqual(selectDocuments(documents, new Set()), documents);
});
