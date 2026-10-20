import {
  EMPTY_SIDEBAR_LAYOUT,
  SidebarLayoutRecord,
  SidebarLayoutError,
  type SidebarLayout,
  type SidebarLayoutMutation,
  type SidebarLayoutUpdate,
} from "@t3tools/contracts";
import { applySidebarLayoutMutation } from "@t3tools/shared/sidebarLayout";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Settings from "./serverSettings.ts";
import { subscribeBeforeSnapshot } from "./utils/subscribeBeforeSnapshot.ts";

interface ProjectChange {
  projectId: string;
  workspaceRoot?: string | undefined;
  sectionId?: string | null | undefined;
  expanded?: boolean | undefined;
  deleted?: boolean;
}
export class SidebarLayoutService extends Context.Service<
  SidebarLayoutService,
  {
    readonly get: Effect.Effect<SidebarLayoutRecord, SidebarLayoutError>;
    readonly update: (
      input: SidebarLayoutUpdate,
    ) => Effect.Effect<SidebarLayoutRecord, SidebarLayoutError>;
    readonly stream: Stream.Stream<SidebarLayoutRecord, SidebarLayoutError>;
    /** Holds the section lock; persist runs inside the project's event transaction. */
    readonly withProjectChange: <A, E, R>(
      input: ProjectChange,
      commit: (persist: Effect.Effect<void, SidebarLayoutError>) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SidebarLayoutError, R>;
  }
>()("t3/sidebarLayout/SidebarLayoutService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<SidebarLayoutRecord>(1);
  const decodeLayout = Schema.decodeUnknownEffect(
    Schema.fromJsonString(SidebarLayoutRecord.fields.layout),
  );
  const encodeLayout = Schema.encodeEffect(
    Schema.fromJsonString(SidebarLayoutRecord.fields.layout),
  );
  const error = (cause: unknown) =>
    new SidebarLayoutError({
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const get = Effect.gen(function* () {
    const rows = yield* sql<{
      revision: number;
      legacy_imported_at: string | null;
      legacy_import_id: string | null;
      layout_json: string;
    }>`
      SELECT revision, legacy_imported_at, legacy_import_id, layout_json FROM sidebar_layout WHERE id = 1`;
    const row = rows[0];
    return row === undefined
      ? { revision: 0, legacyImportedAt: null, legacyImportId: null, layout: EMPTY_SIDEBAR_LAYOUT }
      : {
          revision: row.revision,
          legacyImportedAt: row.legacy_imported_at,
          legacyImportId: row.legacy_import_id,
          layout: yield* decodeLayout(row.layout_json),
        };
  }).pipe(Effect.mapError(error));
  const save = (record: SidebarLayoutRecord) =>
    Effect.gen(function* () {
      const encoded = yield* encodeLayout(record.layout);
      yield* sql`
    INSERT INTO sidebar_layout (id, revision, legacy_imported_at, legacy_import_id, layout_json)
    VALUES (1, ${record.revision}, ${record.legacyImportedAt}, ${record.legacyImportId}, ${encoded})
    ON CONFLICT (id) DO UPDATE SET revision = excluded.revision,
      legacy_imported_at = excluded.legacy_imported_at, legacy_import_id = excluded.legacy_import_id, layout_json = excluded.layout_json
  `.pipe(Effect.asVoid);
    }).pipe(Effect.mapError(error));
  const same = (a: SidebarLayoutRecord, b: SidebarLayoutRecord) =>
    a.legacyImportedAt === b.legacyImportedAt &&
    JSON.stringify(a.layout) === JSON.stringify(b.layout);
  const projectRows = projects.list().pipe(Effect.mapError(error));
  // Imports can contain stale projects or a broken entry; keep the valid environment-owned part.
  // A section sent empty is the owner's own empty section; one emptied by stale projects is not.
  const ownLayout = (layout: SidebarLayout, ids: Set<string>): SidebarLayout => {
    const sentEmpty = new Set(
      layout.sidebarProjectSections
        .filter((section) => section.projectKeys.length === 0)
        .map((section) => section.id),
    );
    const seen = new Set<string>();
    const sectionIds = new Set<string>();
    const sections = layout.sidebarProjectSections
      .filter((section) => {
        if (sectionIds.has(section.id)) return false;
        sectionIds.add(section.id);
        return true;
      })
      .map((section) => ({
        ...section,
        projectKeys: section.projectKeys.filter((id) => {
          if (!ids.has(id) || seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
      }));
    const included = new Set(
      sections
        .filter((section) => section.projectKeys.length > 0 || sentEmpty.has(section.id))
        .map((section) => section.id),
    );
    for (const section of sections)
      if (included.has(section.id) && section.parentId) included.add(section.parentId);
    const top = new Set(
      sections.filter((section) => !section.parentId).map((section) => section.id),
    );
    return {
      ...layout,
      sidebarProjectSections: sections
        .filter((section) => included.has(section.id))
        .map((section) => {
          const sanitized = { ...section };
          if (section.parentId && !top.has(section.parentId)) delete sanitized.parentId;
          return sanitized;
        }),
      projectExpandedById: Object.fromEntries(
        Object.entries(layout.projectExpandedById).filter(([id]) => ids.has(id)),
      ),
      projectOrder: [...new Set(layout.projectOrder.filter((id) => ids.has(id)))],
    };
  };
  const organize = (
    layout: SidebarLayout,
    rows: readonly { projectId: string; workspaceRoot: string }[],
    root: string,
    onlyUnsorted: boolean,
  ) =>
    applySidebarLayoutMutation(layout, {
      type: "organize",
      projects: rows.map((row) => ({
        projectKey: row.projectId,
        workspaceRoots: [row.workspaceRoot],
      })),
      root,
      onlyUnsorted,
    })!;
  const update = (input: SidebarLayoutUpdate) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* get;
        let next = current;
        const rows = yield* projectRows;
        const ids = new Set(rows.map((row) => row.projectId as string));
        for (const operation of input.operations) {
          if (operation.type === "migrate") {
            if (next.legacyImportedAt !== null) continue;
            const layout = ownLayout(operation.layout, ids);
            if (
              layout.sidebarProjectSections.length === 0 &&
              layout.projectOrder.length === 0 &&
              Object.keys(layout.projectExpandedById).length === 0
            )
              continue;
            next = {
              ...next,
              layout: applySidebarLayoutMutation(next.layout, { type: "migrate", layout })!,
              legacyImportedAt: DateTime.formatIso(yield* DateTime.now),
              legacyImportId: operation.importId ?? null,
            };
          } else {
            let mutation: SidebarLayoutMutation = operation;
            if ("projectKeys" in mutation)
              mutation = {
                ...mutation,
                projectKeys: mutation.projectKeys.filter((id) => ids.has(id)),
              };
            if (mutation.type === "projectsOrder")
              mutation = {
                ...mutation,
                currentProjectOrder: mutation.currentProjectOrder.filter((id) => ids.has(id)),
                draggedProjectIds: mutation.draggedProjectIds.filter((id) => ids.has(id)),
                targetProjectIds: mutation.targetProjectIds.filter((id) => ids.has(id)),
              };
            if (mutation.type === "organize") {
              next = {
                ...next,
                layout: organize(next.layout, rows, mutation.root, mutation.onlyUnsorted),
              };
            } else {
              if (
                mutation.type === "move" &&
                mutation.sectionId !== null &&
                !next.layout.sidebarProjectSections.some(
                  (section) => section.id === mutation.sectionId,
                )
              ) {
                yield* Effect.logWarning("Skipping sidebar move: section no longer exists.", {
                  sectionId: mutation.sectionId,
                  projectKeys: mutation.projectKeys,
                });
                continue;
              }
              next = { ...next, layout: applySidebarLayoutMutation(next.layout, mutation)! };
            }
          }
        }
        if (same(current, next)) return current;
        next = { ...next, revision: current.revision + 1 };
        yield* sql.withTransaction(save(next)).pipe(Effect.mapError(error));
        yield* PubSub.publish(changes, next);
        return next;
      }).pipe(Effect.uninterruptible),
    );
  const withProjectChange: SidebarLayoutService["Service"]["withProjectChange"] = (input, commit) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* get;
        let layout = current.layout;
        if (
          input.sectionId != null &&
          !layout.sidebarProjectSections.some((s) => s.id === input.sectionId)
        )
          return yield* new SidebarLayoutError({ message: "Section not found." });
        if (input.deleted) {
          const expanded = { ...layout.projectExpandedById };
          delete expanded[input.projectId];
          layout = applySidebarLayoutMutation(layout, {
            type: "move",
            projectKeys: [input.projectId],
            sectionId: null,
          })!;
          layout = {
            ...layout,
            projectExpandedById: expanded,
            projectOrder: layout.projectOrder.filter((id) => id !== input.projectId),
          };
        } else {
          if (input.workspaceRoot !== undefined) {
            const prefs = yield* settings.getSettings.pipe(Effect.mapError(error));
            if (prefs.autoOrganizeByFolder) {
              const rows = (yield* projectRows).filter((row) => row.projectId !== input.projectId);
              layout = organize(
                layout,
                [...rows, { projectId: input.projectId, workspaceRoot: input.workspaceRoot }],
                prefs.projectFolderRoot || prefs.addProjectBaseDirectory,
                true,
              );
            }
          }
          if (input.sectionId !== undefined)
            layout = applySidebarLayoutMutation(layout, {
              type: "move",
              projectKeys: [input.projectId],
              sectionId: input.sectionId,
              ...(input.expanded === undefined ? {} : { expanded: input.expanded }),
            })!;
          else if (input.expanded !== undefined)
            layout = applySidebarLayoutMutation(layout, {
              type: "projectExpanded",
              projectKeys: [input.projectId],
              expanded: input.expanded,
            })!;
        }
        const next = { ...current, layout, revision: current.revision + 1 };
        const changed = !same(current, next);
        let persisted = false;
        const persist = changed
          ? save(next).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  persisted = true;
                }),
              ),
            )
          : Effect.void;
        const result = yield* commit(persist);
        if (persisted) yield* PubSub.publish(changes, next);
        return result;
      }).pipe(Effect.uninterruptible),
    );
  const stream = Stream.unwrap(
    subscribeBeforeSnapshot(changes, get, lock).pipe(
      Effect.map(({ latest, changes }) => Stream.concat(Stream.succeed(latest), changes)),
    ),
  );
  return SidebarLayoutService.of({ get, update, stream, withProjectChange });
});
export const layer = Layer.effect(SidebarLayoutService, make).pipe(
  Layer.provide(ProjectStore.layer),
);
