# MDX Readmes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate GitHub/npm-compatible README.md files from canonical MDX sources without adding runtime dependencies to published packages.

**Architecture:** A Node-only root script parses and validates three MDX sources, emits only Markdown-safe bodies, and either writes or verifies matching README.md outputs. The root Taskfile owns the operation and keeps the existing package Taskfile hierarchy intact.

**Tech Stack:** TypeScript-free Node ESM script, unified, remark-parse, remark-mdx, remark-frontmatter, remark-stringify, yaml, pnpm, Task.

## Global Constraints

- The root documentation dependencies are development dependencies only.
- `@agentic-research/depgraph-core` remains workerd/browser-safe and imports no Node or documentation tooling.
- `@agentic-research/depgraph-collect` remains Node-only.
- Generated README.md files are committed and are the only readme files included in npm packages.
- Root Taskfile includes package Taskfiles and subdirectory checks continue to run through Task namespacing.

---

### Task 1: Define and test the README renderer

**Files:**

- Create: `scripts/readmes.mjs`
- Create: `scripts/readmes.test.mjs`

**Interfaces:**

- Consumes: an MDX string and document descriptor.
- Produces: `renderReadme(source, descriptor): Promise<string>` and a CLI that writes or checks all documented readmes.

- [ ] **Step 1: Write the failing tests**

```js
assert.equal(
  await renderReadme(
    "---\ntitle: Example\nsummary: Test\n---\n\n# Hello\n",
    root,
  ),
  "# Hello\n",
);
await assert.rejects(() => renderReadme("# Hello\n", root), /frontmatter/);
await assert.rejects(
  () => renderReadme("---\ntitle: X\nsummary: Y\n---\n\n<Component />\n", root),
  /unsupported MDX/,
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test scripts/readmes.test.mjs`

Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Implement the minimal renderer and CLI**

```js
export async function renderReadme(source, descriptor) {
  // parse MDX, validate frontmatter, reject MDX-only nodes, stringify Markdown
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test scripts/readmes.test.mjs`

Expected: PASS.

### Task 2: Author canonical sources and Task integration

**Files:**

- Create: `README.mdx`
- Create: `packages/core/docs/readme.mdx`
- Create: `packages/collect/docs/readme.mdx`
- Modify: `README.md`
- Modify: `packages/core/README.md`
- Modify: `packages/collect/README.md`
- Modify: `package.json`
- Modify: `Taskfile.yml`

**Interfaces:**

- Consumes: the three adjacent MDX source/readme output pairs.
- Produces: root `readmes` and `readmes:check` tasks.

- [ ] **Step 1: Add frontmatter to each source and generate the outputs**

```mdx
---
title: 0day API
summary: Derive dependency maps from repository declarations.
---
```

- [ ] **Step 2: Add root-only development dependencies and scripts**

```json
"readmes": "node scripts/readmes.mjs",
"readmes:check": "node scripts/readmes.mjs --check"
```

- [ ] **Step 3: Wire the README check into the root gate**

```yaml
readmes:check:
  cmds:
    - pnpm run readmes:check
```

- [ ] **Step 4: Verify outputs are current and package tarballs omit MDX**

Run: `task readmes:check && pnpm --filter @agentic-research/depgraph-core pack --pack-destination /tmp && pnpm --filter @agentic-research/depgraph-collect pack --pack-destination /tmp`

Expected: README checks pass and each tarball contains `README.md` but not `README.mdx`.

### Task 3: Run the full release-quality gate

**Files:**

- Verify: `Taskfile.yml`
- Verify: `packages/core/Taskfile.yml`
- Verify: `packages/collect/Taskfile.yml`

- [ ] **Step 1: Run the standard full gate**

Run: `task check`

Expected: format, TypeScript checks, package checks, workerd portability test, and fidelity gate pass.

- [ ] **Step 2: Inspect the final diff and generated-document status**

Run: `git diff --check && git status --short && task readmes:check`

Expected: no whitespace errors and no stale README output.
