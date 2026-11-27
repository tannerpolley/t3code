import {
  ProjectArtifactError,
  type ProjectArtifact,
  type ProjectArtifactAddInput,
  type ProjectArtifactRemoveInput,
  type ProjectArtifactUpdateInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.ts";

type ArtifactEffect<A> = Effect.Effect<A, ProjectArtifactError>;

export class ProjectArtifacts extends Context.Service<
  ProjectArtifacts,
  {
    readonly list: (projectId: ProjectId) => ArtifactEffect<readonly ProjectArtifact[]>;
    readonly add: (
      input: ProjectArtifactAddInput,
      addedBy: "user" | "agent",
    ) => ArtifactEffect<ProjectArtifact>;
    readonly update: (input: ProjectArtifactUpdateInput) => ArtifactEffect<void>;
    readonly remove: (input: ProjectArtifactRemoveInput) => ArtifactEffect<void>;
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<readonly ProjectArtifact[], ProjectArtifactError>;
  }
>()("t3/project/ProjectArtifacts") {}

const storageError = (cause: unknown) => new ProjectArtifactError({ reason: "storage", cause });

export const layer = Layer.effect(
  ProjectArtifacts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    const projects = yield* ProjectStoreV2;
    const files = yield* WorkspaceFileSystem;
    const random = yield* SecureRandom.SecureRandom;
    const changes = yield* PubSub.unbounded<ProjectId>();

    // Match the old fork table so cutover databases keep their pins and remain readable by older builds.
    yield* sql`CREATE TABLE IF NOT EXISTS project_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      label TEXT,
      added_by TEXT NOT NULL CHECK (added_by IN ('user', 'agent')),
      section TEXT NOT NULL DEFAULT 'Files',
      description TEXT,
      UNIQUE(project_id, path)
    )`;

    const rootFor = Effect.fn("ProjectArtifacts.rootFor")(function* (projectId: ProjectId) {
      const project = yield* projects.getShell(projectId).pipe(Effect.mapError(storageError));
      if (Option.isNone(project)) {
        return yield* new ProjectArtifactError({ reason: "missing-project" });
      }
      return project.value.workspaceRoot;
    });
    const list = Effect.fn("ProjectArtifacts.list")(function* (projectId: ProjectId) {
      const root = yield* rootFor(projectId);
      const rows = yield* sql<ProjectArtifact>`
        SELECT id, path, label, description FROM project_artifacts
        WHERE project_id = ${projectId} ORDER BY rowid
      `.pipe(Effect.mapError(storageError));
      return rows.map((row) => ({ ...row, path: path.resolve(root, row.path) }));
    });

    const publishWrite = <A>(projectId: ProjectId, write: ArtifactEffect<A>) =>
      write.pipe(
        Effect.tap(() => PubSub.publish(changes, projectId)),
        Effect.uninterruptible,
      );

    const add: ProjectArtifacts["Service"]["add"] = Effect.fn("ProjectArtifacts.add")(
      function* (input, addedBy) {
        const root = yield* rootFor(input.projectId);
        const resolved = yield* files.resolveExistingFile({ cwd: root, relativePath: input.path });
        if (resolved === null) return yield* new ProjectArtifactError({ reason: "invalid-file" });
        const storedPath = isWithinRoot(path, resolved, root)
          ? path.relative(root, resolved)
          : resolved;
        const id = yield* random.uuidV4();
        return yield* publishWrite(
          input.projectId,
          Effect.gen(function* () {
            const [row] = yield* sql<ProjectArtifact>`
          INSERT INTO project_artifacts (id, project_id, path, label, description, added_by)
          VALUES (${id}, ${input.projectId}, ${storedPath}, ${input.label ?? null}, ${input.description ?? null}, ${addedBy})
          ON CONFLICT(project_id, path) DO UPDATE SET path = excluded.path
          RETURNING id, path, label, description
        `.pipe(Effect.mapError(storageError));
            if (row === undefined) return yield* new ProjectArtifactError({ reason: "storage" });
            return { ...row, path: resolved };
          }),
        );
      },
    );
    const update: ProjectArtifacts["Service"]["update"] = Effect.fn("ProjectArtifacts.update")(
      function* ({ projectId, id, label, description }) {
        yield* rootFor(projectId);
        yield* publishWrite(
          projectId,
          Effect.gen(function* () {
            const [row] = yield* sql<{ id: string }>`
            UPDATE project_artifacts
            SET label = ${label === undefined ? sql`label` : label},
                description = ${description === undefined ? sql`description` : description}
            WHERE project_id = ${projectId} AND id = ${id}
            RETURNING id
          `.pipe(Effect.mapError(storageError));
            if (row === undefined)
              return yield* new ProjectArtifactError({ reason: "missing-artifact" });
          }),
        );
      },
    );
    const remove: ProjectArtifacts["Service"]["remove"] = Effect.fn("ProjectArtifacts.remove")(
      function* ({ projectId, id }) {
        yield* rootFor(projectId);
        yield* publishWrite(
          projectId,
          sql`
          DELETE FROM project_artifacts WHERE project_id = ${projectId} AND id = ${id}
        `.pipe(Effect.asVoid, Effect.mapError(storageError)),
        );
      },
    );
    const subscribe = (projectId: ProjectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.succeed(projectId),
            Stream.fromSubscription(subscription),
          ).pipe(
            Stream.filter((changed) => changed === projectId),
            Stream.mapEffect(() => list(projectId)),
          );
        }),
      );

    return ProjectArtifacts.of({ list, add, update, remove, subscribe });
  }),
);
