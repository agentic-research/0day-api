# MDX Readmes Design

## Goal

Make the root and published package readmes agent-and-human-native by authoring
them as MDX with typed frontmatter, while committing ordinary Markdown for
GitHub and npm.

## Architecture

The root `README.mdx` and each package's `docs/readme.mdx` are canonical
sources for their generated `README.md` files. Package sources deliberately
live outside the package root, because npm always includes README-named files.
A root-only documentation generator reads all three sources, validates a small
frontmatter contract, rejects MDX constructs that GitHub and npm cannot render,
and writes Markdown bodies. The generator and its parsing dependencies are
root development dependencies only; neither published package imports or ships
them.

The root Taskfile remains the hierarchy root and includes the package
Taskfiles. It owns `readmes`, `readmes:check`, and invokes the latter from the
repository gate. Package Taskfiles stay focused on their respective package
build, test, and release operations.

## Document Contract

Each source contains YAML frontmatter with `title` and `summary`. Package
sources also contain `package` and `runtime`, respectively `workerd-browser`
and `node`. The rendered body is CommonMark/GFM-compatible Markdown. JSX,
ESM, and JavaScript expression MDX nodes are rejected deliberately: preserving
an MDX source should never cause a GitHub/npm README to silently lose content.

## Verification

The generator is covered with fixtures for successful frontmatter removal,
missing required metadata, and unsupported MDX syntax. `readmes:check` fails
when a committed README differs from its generated counterpart. The standard
Task gate runs the check before package verification, and package tarball
inspection proves source MDX and root tooling do not enter published packages.
