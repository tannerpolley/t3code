import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EMPTY_SIDEBAR_LAYOUT,
  ProjectId,
  SidebarLayout,
  SidebarLayoutRecord,
  type SidebarLayoutMutation,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "./serverSettings.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Projects from "./orchestration-v2/ProjectStore.ts";
import * as Sidebar from "./sidebarLayout.ts";

const decodeLayout = Schema.decodeUnknownEffect(SidebarLayout);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(SidebarLayoutRecord));
const row = (id: string, workspaceRoot = "/work/Apps/" + id): Projects.ProjectRow => ({
  projectId: ProjectId.make(id),
  workspaceRoot,
  title: id,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  deletedAt: null,
});
const layer = Layer.effect(Sidebar.SidebarLayoutService, Sidebar.make).pipe(
  Layer.provide(
    Layer.mock(Projects.ProjectStoreV2)({ list: () => Effect.succeed([row("a"), row("b")]) }),
  ),
  Layer.provideMerge(Settings.layerTest()),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);
const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    Sidebar.SidebarLayoutService | Settings.ServerSettingsService | SqlClient.SqlClient
  >,
) => body.pipe(Effect.provide(Layer.fresh(layer)));

it.effect("applies nesting, ordering, membership, deletion and expansion through one service", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Sidebar.SidebarLayoutService;
      const update = (...operations: SidebarLayoutMutation[]) =>
        service.update({ revision: 0, operations });
      yield* update(
        { type: "add", section: { id: "work", name: "Work" } },
        { type: "add", section: { id: "child", name: "Child", parentId: "work" } },
        { type: "add", section: { id: "other", name: "Other" } },
        { type: "move", sectionId: "child", projectKeys: ["a", "b"] },
        { type: "sectionExpanded", sectionId: "work", expanded: false },
        { type: "sectionExpanded", sectionId: "child", expanded: false },
        { type: "projectExpanded", projectKeys: ["a"], expanded: true },
        { type: "projectExpanded", projectKeys: ["b"], expanded: false },
        { type: "sectionProjectsOrder", sectionId: "child", projectKeys: ["b", "a"] },
        { type: "sectionsOrder", sectionIds: ["other", "work", "child"] },
        { type: "rename", sectionId: "child", name: "Projects" },
      );
      let layout = (yield* service.get).layout;
      assert.deepEqual(
        layout.sidebarProjectSections.map((s) => s.id),
        ["other", "work", "child"],
      );
      assert.deepEqual(layout.sidebarProjectSections[2]?.projectKeys, ["b", "a"]);
      assert.equal(layout.sidebarProjectSections[2]?.name, "Projects");
      assert.isFalse(layout.sidebarProjectSections[1]!.collapsed);
      assert.isFalse(layout.sidebarProjectSections[2]!.collapsed);
      assert.deepEqual(layout.projectExpandedById, { a: true, b: false });
      yield* update({ type: "delete", sectionId: "child" });
      layout = (yield* service.get).layout;
      assert.deepEqual(layout.sidebarProjectSections[1]?.projectKeys, ["b", "a"]);
    }),
  ),
);

it.effect(
  "ordinary writes before import do not block it; concurrent first imports have one winner",
  () =>
    run(
      Effect.gen(function* () {
        const service = yield* Sidebar.SidebarLayoutService;
        yield* service.update({
          revision: 0,
          operations: [{ type: "otherExpanded", expanded: false }],
        });
        assert.isNull((yield* service.get).legacyImportedAt);
        const candidate = (id: string) => ({
          ...EMPTY_SIDEBAR_LAYOUT,
          sidebarProjectSections: [
            { id, name: id, projectKeys: ["a"], collapsed: false },
            {
              id: "foreign",
              name: "Foreign",
              projectKeys: ["other-environment"],
              collapsed: false,
            },
            { id: "empty", name: "Empty", projectKeys: [], collapsed: false },
          ],
        });
        yield* Effect.all(
          ["first", "second"].map((id) =>
            service.update({
              revision: 0,
              operations: [{ type: "migrate", layout: candidate(id), importId: id }],
            }),
          ),
          { concurrency: "unbounded" },
        );
        const winner = yield* service.get;
        assert.isNotNull(winner.legacyImportedAt);
        assert.deepEqual(
          winner.layout.sidebarProjectSections.map((s) => s.id),
          [winner.legacyImportId, "empty"],
        );
        yield* service.update({
          revision: 0,
          operations: [{ type: "delete", sectionId: winner.legacyImportId! }],
        });
        const cleared = yield* service.get;
        yield* service.update({
          revision: 0,
          operations: [{ type: "migrate", layout: candidate("later") }],
        });
        assert.deepEqual(yield* service.get, cleared);
      }),
    ),
);

it.effect(
  "no-op operations neither persist a revision nor broadcast, and stale expansion applies",
  () =>
    run(
      Effect.gen(function* () {
        const service = yield* Sidebar.SidebarLayoutService;
        const ready = yield* Deferred.make<void>();
        const changed = yield* Deferred.make<void>();
        const received = yield* service.stream.pipe(
          Stream.tap((record) =>
            record.revision === 0
              ? Deferred.succeed(ready, undefined)
              : record.revision === 1
                ? Deferred.succeed(changed, undefined)
                : Effect.void,
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        const secondReady = yield* Deferred.make<void>();
        const secondChanged = yield* Deferred.make<void>();
        const second = yield* service.stream.pipe(
          Stream.tap((record) =>
            record.revision === 0
              ? Deferred.succeed(secondReady, undefined)
              : record.revision === 1
                ? Deferred.succeed(secondChanged, undefined)
                : Effect.void,
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* Deferred.await(secondReady);
        const update = (...operations: SidebarLayoutMutation[]) =>
          service.update({ revision: 0, operations });
        yield* update({ type: "otherExpanded", expanded: true });
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql.unsafe("SELECT * FROM sidebar_layout")).length, 0);
        yield* update({ type: "add", section: { id: "work", name: "Work" } });
        yield* Deferred.await(changed);
        yield* Deferred.await(secondChanged);
        yield* update({ type: "rename", sectionId: "work", name: "Work" });
        assert.equal((yield* service.get).revision, 1);
        yield* update({ type: "sectionExpanded", sectionId: "work", expanded: false });
        const records = yield* Fiber.join(received);
        assert.deepEqual(yield* Fiber.join(second), records);
        assert.deepEqual(
          records.map((record) => record.revision),
          [0, 1, 2],
        );
        assert.isTrue(records[2]!.layout.sidebarProjectSections[0]!.collapsed);
        const payload = yield* encodeRecord(records[2]!);
        assert.isBelow(new TextEncoder().encode(payload).length, 1024);
      }),
    ),
);

it.effect("project lifecycle organization is idempotent, and long folders stay decodable", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Sidebar.SidebarLayoutService;
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ projectFolderRoot: "/work" });
      const change = { projectId: "new", workspaceRoot: "/work/" + "x".repeat(100) + "/new" };
      yield* service.withProjectChange(change, (persist) => persist);
      const organized = yield* service.get;
      assert.equal(
        organized.layout.sidebarProjectSections.find((section) => section.name.startsWith("x"))!
          .name.length,
        80,
      );
      yield* decodeLayout(organized.layout);
      yield* service.withProjectChange(change, (persist) => persist);
      assert.equal((yield* service.get).revision, organized.revision);
      yield* service.withProjectChange({ projectId: "new", deleted: true }, (persist) => persist);
      assert.deepEqual(
        (yield* service.get).layout.sidebarProjectSections.find((section) =>
          section.name.startsWith("x"),
        )?.projectKeys,
        [],
      );
    }),
  ),
);

it.effect("a malformed section is dropped without losing valid entries", () =>
  decodeLayout({
    ...EMPTY_SIDEBAR_LAYOUT,
    projectExpandedById: { a: "invalid", b: false },
    projectOrder: ["b", 42],
    sidebarProjectSections: [
      { id: "invalid", name: "x".repeat(100), projectKeys: ["a"], collapsed: false },
      { id: "valid", name: "Valid", projectKeys: ["b"], collapsed: false },
    ],
  }).pipe(
    Effect.map((layout) =>
      assert.deepEqual(
        layout.sidebarProjectSections.map((s) => s.id),
        ["valid"],
      ),
    ),
  ),
);

it.effect("a move to a concurrently deleted section does not discard other batched edits", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Sidebar.SidebarLayoutService;
      const before = yield* service.update({
        revision: 0,
        operations: [
          { type: "add", section: { id: "work", name: "Work" } },
          { type: "add", section: { id: "deleted", name: "Deleted" } },
          { type: "delete", sectionId: "deleted" },
        ],
      });
      const invalid: SidebarLayoutMutation = {
        type: "move",
        sectionId: "deleted",
        projectKeys: ["a"],
      };
      const after = yield* service.update({
        revision: 0,
        operations: [
          { type: "projectExpanded", projectKeys: ["a"], expanded: false },
          invalid,
          { type: "rename", sectionId: "work", name: "Renamed" },
          { type: "move", sectionId: "work", projectKeys: ["b"] },
        ],
      });
      assert.equal(after.revision, before.revision + 1);
      assert.deepEqual(after.layout.projectExpandedById, { a: false });
      assert.equal(after.layout.sidebarProjectSections[0]!.name, "Renamed");
      assert.deepEqual(after.layout.sidebarProjectSections[0]!.projectKeys, ["b"]);
      // A rejected operation by itself remains a no-op.
      assert.deepEqual(yield* service.update({ revision: 0, operations: [invalid] }), after);
    }),
  ),
);
