import {
  EMPTY_SIDEBAR_LAYOUT,
  SidebarLayout,
  SidebarLayoutError,
  type SidebarLayoutMutation,
  type SidebarLayoutRecord,
  type SidebarLayoutUpdate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { subscribeBeforeSnapshot } from "./utils/subscribeBeforeSnapshot.ts";

function applyMutation(layout: SidebarLayout, mutation: SidebarLayoutMutation): SidebarLayout {
  const sections = layout.sidebarProjectSections;
  switch (mutation.type) {
    case "add": {
      const next = sections.some((section) => section.id === mutation.sectionId)
        ? layout
        : {
            ...layout,
            sidebarProjectSections: [
              ...sections,
              { id: mutation.sectionId, name: mutation.name, projectKeys: [], collapsed: false },
            ],
          };
      return mutation.projectIds === undefined
        ? next
        : applyMutation(next, {
            type: "move",
            sectionId: mutation.sectionId,
            projectIds: mutation.projectIds,
          });
    }
    case "rename":
    case "collapse":
      return {
        ...layout,
        sidebarProjectSections: sections.map((section) =>
          section.id !== mutation.sectionId
            ? section
            : mutation.type === "rename"
              ? { ...section, name: mutation.name }
              : { ...section, collapsed: mutation.collapsed },
        ),
      };
    case "delete": {
      const deleted = sections.find((section) => section.id === mutation.sectionId);
      return {
        ...layout,
        sidebarProjectSections: sections
          .filter((section) => section.id !== mutation.sectionId)
          .map((section) => {
            const next = { ...section };
            if (next.parentId === mutation.sectionId) {
              if (deleted?.parentId === undefined) delete next.parentId;
              else next.parentId = deleted.parentId;
            }
            if (next.childOrder)
              next.childOrder = next.childOrder.filter(
                (key) => key !== `section:${mutation.sectionId}`,
              );
            return next;
          }),
      };
    }
    case "move": {
      const moved = new Set<string>(mutation.projectIds);
      return {
        ...layout,
        sidebarProjectSections: sections.map((section) => {
          const projectKeys = section.projectKeys.filter((key) => !moved.has(key));
          const childOrder = section.childOrder?.filter((key) => !moved.has(key));
          if (section.id === mutation.sectionId) {
            projectKeys.push(...moved);
            childOrder?.push(...moved);
          }
          return { ...section, projectKeys, ...(childOrder === undefined ? {} : { childOrder }) };
        }),
      };
    }
    case "expandProjects":
      return {
        ...layout,
        projectExpandedById: {
          ...layout.projectExpandedById,
          ...Object.fromEntries(mutation.projectIds.map((id) => [id, mutation.expanded])),
        },
      };
    case "placeThreads":
      return { ...layout, threadRanks: { ...layout.threadRanks, ...mutation.ranks } };
  }
}

export class SidebarLayoutService extends Context.Service<
  SidebarLayoutService,
  {
    readonly get: Effect.Effect<SidebarLayoutRecord, SidebarLayoutError>;
    readonly update: (
      input: SidebarLayoutUpdate,
    ) => Effect.Effect<SidebarLayoutRecord, SidebarLayoutError>;
    readonly stream: Stream.Stream<SidebarLayoutRecord, SidebarLayoutError>;
  }
>()("t3/sidebarLayout/SidebarLayoutService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Preserve the fork's table and keep its schema outside the upstream migration ledger.
  yield* sql`CREATE TABLE IF NOT EXISTS sidebar_layout (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    legacy_imported_at TEXT,
    legacy_import_id TEXT,
    layout_json TEXT NOT NULL
  )`;
  const mutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<SidebarLayoutRecord>(1);
  const json = Schema.fromJsonString(SidebarLayout);
  const decode = Schema.decodeUnknownEffect(json);
  const encode = Schema.encodeEffect(json);
  const get = Effect.fn("SidebarLayout.get")(
    function* () {
      const [row] = yield* sql<{ revision: number; layout_json: string }>`
      SELECT revision, layout_json FROM sidebar_layout WHERE id = 1
    `;
      return row === undefined
        ? { revision: 0, layout: EMPTY_SIDEBAR_LAYOUT }
        : { revision: row.revision, layout: yield* decode(row.layout_json) };
    },
    Effect.mapError((cause) => new SidebarLayoutError({ reason: "read", cause })),
  );
  const update = Effect.fn("SidebarLayout.update")(
    function* ({ revision, mutation }: SidebarLayoutUpdate) {
      const current = yield* get();
      if (current.revision !== revision) return yield* new SidebarLayoutError({ reason: "stale" });
      if (
        "sectionId" in mutation &&
        mutation.type !== "add" &&
        mutation.sectionId !== null &&
        !current.layout.sidebarProjectSections.some((section) => section.id === mutation.sectionId)
      ) {
        return yield* new SidebarLayoutError({ reason: "missing-section" });
      }
      if ("projectIds" in mutation && mutation.projectIds !== undefined) {
        const ids = [...new Set(mutation.projectIds)];
        const rows = yield* sql<{ project_id: string }>`
        SELECT project_id FROM projection_projects
        WHERE deleted_at IS NULL AND ${sql.in("project_id", ids)}
      `;
        if (rows.length !== ids.length)
          return yield* new SidebarLayoutError({ reason: "missing-project" });
      }
      if (mutation.type === "placeThreads") {
        const ids = Object.keys(mutation.ranks);
        if (ids.length === 0) return current;
        const rows = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND archived_at IS NULL AND ${sql.in("thread_id", ids)}
      `;
        if (rows.length !== ids.length)
          return yield* new SidebarLayoutError({ reason: "missing-thread" });
      }
      const next = { revision: revision + 1, layout: applyMutation(current.layout, mutation) };
      const encoded = yield* encode(next.layout);
      yield* sql`
      INSERT INTO sidebar_layout (id, revision, layout_json)
      VALUES (1, ${next.revision}, ${encoded})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, layout_json = excluded.layout_json
    `;
      return next;
    },
    (write) =>
      mutex.withPermits(1)(
        sql.withTransaction(write).pipe(
          Effect.mapError((cause) =>
            cause instanceof SidebarLayoutError
              ? cause
              : new SidebarLayoutError({ reason: "write", cause }),
          ),
          Effect.tap((next) => PubSub.publish(changes, next)),
          Effect.uninterruptible,
        ),
      ),
  );
  const stream = Stream.unwrap(
    subscribeBeforeSnapshot(changes, get(), mutex).pipe(
      Effect.map(({ latest, changes }) => Stream.concat(Stream.succeed(latest), changes)),
    ),
  );
  return SidebarLayoutService.of({ get: get(), update, stream });
});

export const layer = Layer.effect(SidebarLayoutService, make);
