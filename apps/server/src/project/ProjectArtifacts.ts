import {
  defaultArtifactSection,
  ProjectArtifactError,
  type ProjectArtifact,
  type ProjectArtifactAddInput,
  type ProjectArtifactMoveInput,
  type ProjectArtifactRemoveInput,
  type ProjectArtifactUpdateInput,
  type ProjectArtifactRenameSectionInput,
  type ProjectArtifactReorderSectionsInput,
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
import type * as SqlError from "effect/sql/SqlError";
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
    readonly move: (input: ProjectArtifactMoveInput) => Effect.Effect<void, ProjectArtifactError>;
    readonly update: (
      input: ProjectArtifactUpdateInput,
    ) => Effect.Effect<void, ProjectArtifactError>;
    readonly renameSection: (
      input: ProjectArtifactRenameSectionInput,
    ) => Effect.Effect<void, ProjectArtifactError>;
    readonly reorderSections: (
      input: ProjectArtifactReorderSectionsInput,
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
    description: string | null;
    section: string;
    added_by: "user" | "agent";
  }
  const present = Effect.fn("ProjectArtifacts.present")(function* (root: string, row: Row) {
    const resolved = yield* resolve(root, row.path).pipe(Effect.option);
    return {
      id: row.id,
      path: row.path,
      label: row.label,
      description: row.description,
      section: row.section,
      addedBy: row.added_by,
      name: path.basename(row.path),
      available: Option.isSome(resolved),
      resolvedPath: Option.isSome(resolved) ? resolved.value.real : path.resolve(root, row.path),
    } satisfies ProjectArtifact;
  });
  const list = Effect.fn("ProjectArtifacts.list")(function* (projectId: ProjectId) {
    const root = yield* rootFor(projectId);
    const rows =
      yield* sql<Row>`SELECT a.id, a.path, a.label, a.description, a.section, a.added_by FROM project_artifacts a
        LEFT JOIN project_artifact_sections s ON s.project_id = a.project_id AND s.name = a.section
        WHERE a.project_id = ${projectId}
        ORDER BY s.position IS NULL, s.position, a.section, a.rowid`.pipe(
        Effect.mapError(storageError),
      );
    return yield* Effect.forEach(rows, (row) => present(root, row));
  });
  // Every section in use has an order row; new ones go last and empty ones lose theirs.
  const ensureSection = (projectId: ProjectId, name: string) =>
    sql`INSERT OR IGNORE INTO project_artifact_sections (project_id, name, position)
      SELECT ${projectId}, ${name}, COALESCE(MAX(position) + 1, 0)
      FROM project_artifact_sections WHERE project_id = ${projectId}`;
  const pruneSections = (projectId: ProjectId) =>
    sql`DELETE FROM project_artifact_sections WHERE project_id = ${projectId}
      AND name NOT IN (SELECT section FROM project_artifacts WHERE project_id = ${projectId})`;
  const write = Effect.fn("ProjectArtifacts.write")(
    function* <A>(
      projectId: ProjectId,
      change: (root: string) => Effect.Effect<A, ProjectArtifactError | SqlError.SqlError>,
    ) {
      const root = yield* rootFor(projectId);
      const result = yield* sql
        .withTransaction(change(root))
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      yield* PubSub.publish(changes, projectId);
      return result;
    },
    Effect.uninterruptible,
    lock.withPermits(1),
  );
  const add = Effect.fn("ProjectArtifacts.add")(function* (
    input: ProjectArtifactAddInput,
    addedBy: "user" | "agent",
  ) {
    return yield* write(input.projectId, (root) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(root, input.path.trim());
        const section = input.section ?? defaultArtifactSection(resolved.stored);
        // A repeated pin keeps its metadata and attribution.
        const rows =
          yield* sql<Row>`INSERT INTO project_artifacts (id, project_id, path, label, description, section, added_by)
        VALUES (lower(hex(randomblob(16))), ${input.projectId}, ${resolved.stored}, ${input.label?.trim() || null}, ${input.description?.trim() || null}, ${section}, ${addedBy})
        ON CONFLICT(project_id, path) DO UPDATE SET path = excluded.path
        RETURNING id, path, label, description, section, added_by`;
        yield* ensureSection(input.projectId, rows[0]!.section);
        return yield* present(root, rows[0]!);
      }),
    );
  });
  const remove = Effect.fn("ProjectArtifacts.remove")(function* (
    input: ProjectArtifactRemoveInput,
  ) {
    yield* write(input.projectId, () =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM project_artifacts WHERE project_id = ${input.projectId} AND id = ${input.id}`;
        yield* pruneSections(input.projectId);
      }),
    );
  });
  const move = Effect.fn("ProjectArtifacts.move")(function* (input: ProjectArtifactMoveInput) {
    yield* write(input.projectId, () =>
      Effect.gen(function* () {
        yield* sql`UPDATE project_artifacts SET section = ${input.section}
          WHERE project_id = ${input.projectId} AND id = ${input.id}`;
        yield* ensureSection(input.projectId, input.section);
        yield* pruneSections(input.projectId);
      }),
    );
  });
  const update = Effect.fn("ProjectArtifacts.update")(function* (
    input: ProjectArtifactUpdateInput,
  ) {
    yield* write(
      input.projectId,
      () =>
        sql`UPDATE project_artifacts SET
        label = CASE WHEN ${input.label !== undefined} THEN ${input.label?.trim() || null} ELSE label END,
        description = CASE WHEN ${input.description !== undefined} THEN ${input.description?.trim() || null} ELSE description END
        WHERE project_id = ${input.projectId} AND id = ${input.id}`,
    );
  });
  const renameSection = Effect.fn("ProjectArtifacts.renameSection")(function* (
    input: ProjectArtifactRenameSectionInput,
  ) {
    yield* write(input.projectId, () =>
      Effect.gen(function* () {
        yield* sql`UPDATE project_artifacts SET section = ${input.to}
          WHERE project_id = ${input.projectId} AND section = ${input.from}`;
        // Renaming onto an existing section merges into it and keeps its place.
        yield* sql`UPDATE OR IGNORE project_artifact_sections SET name = ${input.to}
          WHERE project_id = ${input.projectId} AND name = ${input.from}`;
        yield* pruneSections(input.projectId);
      }),
    );
  });
  const reorderSections = Effect.fn("ProjectArtifacts.reorderSections")(function* (
    input: ProjectArtifactReorderSectionsInput,
  ) {
    yield* write(input.projectId, () =>
      Effect.gen(function* () {
        // Sections the client did not list keep their relative order after the listed ones.
        yield* sql`UPDATE project_artifact_sections SET position = position + ${input.sections.length}
          WHERE project_id = ${input.projectId}`;
        yield* Effect.forEach(
          input.sections,
          (name, position) =>
            sql`UPDATE project_artifact_sections SET position = ${position}
              WHERE project_id = ${input.projectId} AND name = ${name}`,
          { discard: true },
        );
      }),
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
  return ProjectArtifacts.of({
    list,
    add,
    remove,
    move,
    update,
    renameSection,
    reorderSections,
    subscribe,
  });
});
export const layer = Layer.effect(ProjectArtifacts, make).pipe(Layer.provide(ProjectStore.layer));
