/**
 * The shape of `data/sources.lock.json`.
 *
 * The graph got a schema first, and the lock was left as untyped parsed JSON —
 * which is how `derive` ended up handling `any` everywhere and why converting
 * this tooling to TypeScript surfaced a hundred implicit-any errors in one
 * file. Hand-written interfaces would have silenced them while reintroducing
 * exactly the drift the graph's schema exists to prevent, so the lock gets the
 * same treatment: one Zod definition, types inferred from it, and the collector
 * validating its own output before writing.
 *
 * This is an INTERNAL contract, not a published one. It has no `$schema`, is
 * not served, and may change shape without a version bump — only
 * `site-map.ts` carries a compatibility promise.
 */
import { z } from "zod";

/** A Cargo dependency, with both version facts a git dependency carries. */
const CargoDep = z
  .object({
    name: z.string(),
    table: z.string(),
    package: z.string().nullable(),
    version: z.string().nullable(),
    git: z.string().nullable(),
    rev: z.string().nullable(),
    tag: z.string().nullable(),
    branch: z.string().nullable(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
  })
  .strict();

const CargoFacts = z
  .object({
    package: z
      .object({ name: z.string(), version: z.string().nullable() })
      .strict()
      .nullable(),
    publishes: z.array(z.string()),
    workspaceMembers: z.array(z.string()),
    deps: z.array(CargoDep),
  })
  .strict();

const GoModFacts = z
  .object({
    module: z.string().nullable(),
    publishes: z.array(z.string()),
    requires: z.array(
      z
        .object({
          path: z.string(),
          version: z.string(),
          indirect: z.boolean(),
          line: z.number().int(),
        })
        .strict(),
    ),
    // `replace` directives. A required module that is also replaced does not
    // resolve from the module proxy at all — it resolves from wherever `with`
    // points, and for a filesystem path that is a location this graph cannot
    // verify anything about. Recording the directive is what lets derive.ts
    // tell those two edges apart; see `resolves_from` on the published edge.
    replaces: z.array(
      z
        .object({
          /** The module path being replaced. */
          path: z.string(),
          /** Version being replaced, when the directive pins one. */
          version: z.string().nullable(),
          /** The replacement: a module path, or a filesystem path. */
          with: z.string(),
          /** Replacement version, when the replacement is a module. */
          withVersion: z.string().nullable(),
          /** True when `with` is a filesystem path rather than a module path. */
          local: z.boolean(),
          line: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

const NpmFacts = z
  .object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    publishes: z.array(z.string()),
    deps: z.array(
      z
        .object({
          name: z.string(),
          table: z.string(),
          spec: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const ServerJsonFacts = z
  .object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    repositoryUrl: z.string().nullable(),
    publishes: z.array(z.string()),
    packages: z.array(
      z
        .object({
          registryType: z.string().nullable(),
          identifier: z.string().nullable(),
          version: z.string().nullable(),
        })
        .strict(),
    ),
    remotes: z.array(z.object({ type: z.string().nullable() }).strict()),
    commands: z.array(
      z
        .object({
          metaKey: z.string(),
          transport: z.string(),
          command: z.string(),
        })
        .strict(),
    ),
    declaresCloisterTenancy: z.boolean(),
    requiredDeps: z.array(
      z
        .object({
          metaKey: z.string(),
          server: z.string(),
          minimumVersion: z.string().nullable(),
          purpose: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const ClusterTomlFacts = z
  .object({
    clusterName: z.string().nullable(),
    bundles: z.array(
      z
        .object({
          name: z.string().nullable(),
          kind: z.string().nullable(),
          tier: z.string().nullable(),
          image: z.string().nullable(),
          entryPoint: z.string().nullable(),
          workerdServiceName: z.string().nullable(),
        })
        .strict(),
    ),
    wires: z.array(
      z
        .object({
          from: z.string().nullable(),
          to: z.string().nullable(),
          binding: z.string().nullable(),
          transport: z.string().nullable(),
        })
        .strict(),
    ),
    inputs: z.array(
      z
        .object({
          key: z.string(),
          ref: z.string().nullable(),
          owner: z.string().nullable(),
          repo: z.string().nullable(),
          path: z.string().nullable(),
          rev: z.string().nullable(),
          version: z.string().nullable(),
          line: z.number().int().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const ClusterLockFacts = z
  .object({
    schema: z.string().nullable(),
    cluster: z.string().nullable(),
    inputs: z.array(
      z
        .object({
          key: z.string(),
          owner: z.string().nullable(),
          repo: z.string().nullable(),
          path: z.string().nullable(),
          rev: z.string().nullable(),
          resolved: z.string().nullable(),
          sha256: z.string().nullable(),
          oci: z
            .object({
              identifier: z.string().nullable(),
              version: z.string().nullable(),
              digest: z.string().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const VersionPinFacts = z
  .object({ tool: z.string(), version: z.string() })
  .strict();

const TaskfileFacts = z
  .object({
    releaseRepos: z.array(
      z.object({ owner: z.string(), repo: z.string() }).strict(),
    ),
  })
  .strict();

/**
 * One manifest, read. Discriminated on `format` so a consumer that has checked
 * the format gets the right facts type without a cast.
 */
/**
 * A GitHub Actions workflow, read for its cross-repository event wiring.
 *
 * `repository_dispatch` is a producer -> event -> consumer triple declared on
 * both sides and visible in no package manifest: the consumer names the event
 * types it accepts, the producer names the event and the repository it sends to.
 */
const WorkflowFacts = z
  .object({
    /** Event types this workflow accepts via `on.repository_dispatch.types`. */
    listensFor: z.array(z.string()),
    /** Dispatches this workflow sends. */
    dispatches: z.array(
      z
        .object({
          event: z.string(),
          /**
           * The target repository, when the workflow names one literally.
           * Null when the target is a variable — `repos/${TARGET_REPO}/dispatches`
           * names no repository at read time, and guessing one would invent an
           * edge. The dispatch is still recorded so the gap is visible.
           */
          owner: z.string().nullable(),
          repo: z.string().nullable(),
          line: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

export const Source = z.discriminatedUnion("format", [
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("cargo"),
      facts: CargoFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("gomod"),
      facts: GoModFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("npm"),
      facts: NpmFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("server-json"),
      facts: ServerJsonFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("cluster-toml"),
      facts: ClusterTomlFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("cluster-lock"),
      facts: ClusterLockFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("version-pin"),
      facts: VersionPinFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("taskfile"),
      facts: TaskfileFacts,
    })
    .strict(),
  z
    .object({
      repo: z.string(),
      path: z.string(),
      /** git blob SHA of the manifest read — the content address of the input. */
      blob: z.string().nullable(),
      format: z.literal("workflow"),
      facts: WorkflowFacts,
    })
    .strict(),
]);

export const LockRepo = z
  .object({
    slug: z.string(),
    github: z.string(),
    visibility: z.enum(["public", "restricted"]),
    on_map: z.boolean(),
    read: z.boolean(),
  })
  .strict();

export const SourcesLock = z
  .object({
    schema_version: z.number().int(),
    note: z.string(),
    /**
     * When this collection ran, RFC 3339. The one field that legitimately
     * differs between two collections of identical upstream state, which is
     * why `deps:verify` compares canonical bytes (everything but this) rather
     * than raw file bytes — see canonicalLockBytes().
     */
    collected_at: z.string(),
    /**
     * True when this lock contains manifests from repositories the public
     * cannot read (`--include-private`). Such a lock is a local artifact: the
     * CLI refuses to write it to the published paths, and the graph derived
     * from it is not redacted, because the operator is the audience.
     */
    private_inclusive: z.boolean(),
    repos: z.array(LockRepo),
    sources: z.array(Source),
  })
  .strict();

export type SourcesLock = z.infer<typeof SourcesLock>;
export type LockRepo = z.infer<typeof LockRepo>;
export type Source = z.infer<typeof Source>;
export type CargoFacts = z.infer<typeof CargoFacts>;
export type GoModFacts = z.infer<typeof GoModFacts>;
export type NpmFacts = z.infer<typeof NpmFacts>;
export type ServerJsonFacts = z.infer<typeof ServerJsonFacts>;
export type ClusterTomlFacts = z.infer<typeof ClusterTomlFacts>;
export type ClusterLockFacts = z.infer<typeof ClusterLockFacts>;
export type VersionPinFacts = z.infer<typeof VersionPinFacts>;
export type TaskfileFacts = z.infer<typeof TaskfileFacts>;
export type WorkflowFacts = z.infer<typeof WorkflowFacts>;
