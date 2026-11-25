import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as SidebarLayout from "./sidebarLayout.ts";

it.effect(
  "reads the old layout as-is and persists placement without replacing concurrent edits",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.scoped(Layer.build(SidebarLayout.layer));
      const layout = {
        sidebarProjectSections: [
          {
            id: "parent",
            name: "Research",
            collapsed: false,
            projectKeys: [],
            childOrder: ["section:child"],
          },
          {
            id: "child",
            name: "Research",
            collapsed: true,
            projectKeys: ["project"],
            parentId: "parent",
          },
        ],
        projectExpandedById: { project: false },
        projectOrder: ["project"],
        sidebarOtherProjectsExpanded: true,
      };
      yield* sql`
      INSERT INTO sidebar_layout VALUES (1, 12, 'imported-at', 'preserve-id', ${JSON.stringify(layout)})
    `;
      yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/project', '[]', '2026-01-01', '2026-01-01')
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread', 'project', 'Thread', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}')
    `;
      const thread = ThreadId.make("thread");
      yield* Effect.gen(function* () {
        const service = yield* SidebarLayout.SidebarLayoutService;
        const [initial] = yield* service.stream.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(initial, { revision: 12, layout });
        const renamed = yield* service.update({
          revision: 12,
          mutation: { type: "rename", sectionId: "child", name: "Reading" },
        });
        assert.equal(renamed.layout.sidebarProjectSections[1]?.id, "child");
        const stale = yield* service
          .update({ revision: 12, mutation: { type: "placeThreads", ranks: { [thread]: "m" } } })
          .pipe(Effect.flip);
        assert.equal(stale.reason, "stale");
        const moved = yield* service.update({
          revision: 13,
          mutation: {
            type: "add",
            sectionId: "new",
            name: "Review",
            projectIds: [ProjectId.make("project")],
          },
        });
        assert.deepStrictEqual(moved.layout.sidebarProjectSections[1]?.projectKeys, []);
        assert.deepStrictEqual(moved.layout.sidebarProjectSections[2]?.projectKeys, ["project"]);
        yield* service.update({
          revision: 14,
          mutation: { type: "placeThreads", ranks: { [thread]: "m" } },
        });
      }).pipe(Effect.provide(Layer.fresh(SidebarLayout.layer)));

      const reloaded = yield* Effect.gen(function* () {
        const service = yield* SidebarLayout.SidebarLayoutService;
        return yield* service.get;
      }).pipe(Effect.provide(Layer.fresh(SidebarLayout.layer)));
      assert.equal(reloaded.revision, 15);
      assert.equal(reloaded.layout.sidebarProjectSections[1]?.name, "Reading");
      assert.equal(reloaded.layout.sidebarProjectSections[1]?.parentId, "parent");
      assert.equal(reloaded.layout.sidebarProjectSections[1]?.collapsed, true);
      assert.deepStrictEqual(reloaded.layout.threadRanks, { [thread]: "m" });
      const [row] = yield* sql<{
        legacy_import_id: string;
      }>`SELECT legacy_import_id FROM sidebar_layout`;
      assert.equal(row?.legacy_import_id, "preserve-id");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
