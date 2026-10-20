import {
  ProjectArtifactError,
  type ProjectArtifact,
  type ProjectArtifactAddInput,
  type ProjectArtifactRemoveInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export class ProjectArtifacts extends Context.Service<
  ProjectArtifacts,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly ProjectArtifact[], ProjectArtifactError>;
    readonly add: (
      input: ProjectArtifactAddInput,
      addedBy: "user" | "agent",
    ) => Effect.Effect<ProjectArtifact, ProjectArtifactError>;
    readonly remove: (
      input: ProjectArtifactRemoveInput,
    ) => Effect.Effect<void, ProjectArtifactError>;
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<readonly ProjectArtifact[], ProjectArtifactError>;
  }
>()("t3/project/ProjectArtifacts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const changes = yield* PubSub.unbounded<ProjectId>();
  const lock = yield* Semaphore.make(1);
  const storageError = (cause: unknown) => new ProjectArtifactError({ reason: "storage", cause });
  const rootFor = Effect.fn("ProjectArtifacts.rootFor")(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(storageError));
    if (Option.isNone(project))
      return yield* new ProjectArtifactError({ reason: "project-not-found" });
    return project.value.workspaceRoot;
  });
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const resolve = Effect.fn("ProjectArtifacts.resolve")(function* (
    root: string,
    requested: string,
  ) {
    if (!requested.trim() || requested.includes("\0"))
      return yield* new ProjectArtifactError({ reason: "invalid-path" });
    const absolute = path.isAbsolute(requested);
    const target = path.resolve(root, requested);
    if (!absolute && !inside(root, target))
      return yield* new ProjectArtifactError({ reason: "invalid-path" });
    const real = yield* fs
      .realPath(target)
      .pipe(Effect.mapError((cause) => new ProjectArtifactError({ reason: "not-a-file", cause })));
    const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(storageError));
    // A relative pin never grants access through a symlink outside its project.
    if (!absolute && !inside(realRoot, real))
      return yield* new ProjectArtifactError({ reason: "invalid-path" });
    const stat = yield* fs
      .stat(real)
      .pipe(Effect.mapError((cause) => new ProjectArtifactError({ reason: "not-a-file", cause })));
    if (stat.type !== "File") return yield* new ProjectArtifactError({ reason: "not-a-file" });
    return { real, stored: inside(realRoot, real) ? path.relative(realRoot, real) : real };
  });
  interface Row {
    id: string;
    path: string;
    label: string | null;
    added_by: "user" | "agent";
  }
  const present = Effect.fn("ProjectArtifacts.present")(function* (root: string, row: Row) {
    const resolved = yield* resolve(root, row.path).pipe(Effect.option);
    return {
      id: row.id,
      path: row.path,
      label: row.label,
      addedBy: row.added_by,
      name: path.basename(row.path),
      available: Option.isSome(resolved),
      resolvedPath: Option.isSome(resolved) ? resolved.value.real : path.resolve(root, row.path),
    } satisfies ProjectArtifact;
  });
  const list = Effect.fn("ProjectArtifacts.list")(function* (projectId: ProjectId) {
    const root = yield* rootFor(projectId);
    const rows =
      yield* sql<Row>`SELECT id, path, label, added_by FROM project_artifacts WHERE project_id = ${projectId} ORDER BY rowid`.pipe(
        Effect.mapError(storageError),
      );
    return yield* Effect.forEach(rows, (row) => present(root, row));
  });
  const add = Effect.fn("ProjectArtifacts.add")(function* (
    input: ProjectArtifactAddInput,
    addedBy: "user" | "agent",
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* rootFor(input.projectId);
        const resolved = yield* resolve(root, input.path.trim());
        const rows =
          yield* sql<Row>`INSERT INTO project_artifacts (id, project_id, path, label, added_by)
        VALUES (lower(hex(randomblob(16))), ${input.projectId}, ${resolved.stored}, ${input.label?.trim() || null}, ${addedBy})
        ON CONFLICT(project_id, path) DO UPDATE SET path = excluded.path
        RETURNING id, path, label, added_by`.pipe(Effect.mapError(storageError));
        yield* PubSub.publish(changes, input.projectId);
        return yield* present(root, rows[0]!);
      }).pipe(Effect.uninterruptible),
    );
  });
  const remove = Effect.fn("ProjectArtifacts.remove")(function* (
    input: ProjectArtifactRemoveInput,
  ) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* rootFor(input.projectId);
        yield* sql`DELETE FROM project_artifacts WHERE project_id = ${input.projectId} AND id = ${input.id}`.pipe(
          Effect.mapError(storageError),
        );
        yield* PubSub.publish(changes, input.projectId);
      }).pipe(Effect.uninterruptible),
    );
  });
  const subscribe = (projectId: ProjectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe first so a mutation during the initial read cannot be lost.
        const subscription = yield* PubSub.subscribe(changes);
        const latest = yield* list(projectId);
        return Stream.concat(
          Stream.succeed(latest),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((id) => id === projectId),
            Stream.mapEffect(() => list(projectId)),
          ),
        );
      }),
    );
  return ProjectArtifacts.of({ list, add, remove, subscribe });
});
export const layer = Layer.effect(ProjectArtifacts, make).pipe(Layer.provide(ProjectStore.layer));
