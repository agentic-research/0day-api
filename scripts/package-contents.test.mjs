import assert from "node:assert/strict";
import test from "node:test";

import { validatePackageContents } from "./package-contents.mjs";

test("accepts a package with generated Markdown and no MDX source", () => {
  assert.doesNotThrow(() =>
    validatePackageContents("example", ["dist/index.js", "README.md"]),
  );
});

test("rejects a package that includes MDX source", () => {
  assert.throws(
    () => validatePackageContents("example", ["README.md", "docs/readme.mdx"]),
    /MDX source/i,
  );
});
