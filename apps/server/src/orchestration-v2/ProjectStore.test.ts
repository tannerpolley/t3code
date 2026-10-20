import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );
  },
);

it.effect("project count matches the snapshot's non-deleted rows", () =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    assert.equal(yield* projects.count, 0);
    for (const [index, deleted] of [false, false, true].entries()) {
      const projectId = ProjectId.make(`count-project-${index}`);
      const base = {
        sequence: index + 1,
        eventId: EventId.make(`count-project-created-${index}`),
        aggregateKind: "project" as const,
        aggregateId: projectId,
        occurredAt: "2026-10-20T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      };
      yield* projects.apply({
        ...base,
        type: "project.created",
        payload: {
          projectId,
          title: "Count project",
          workspaceRoot: `/tmp/count-${index}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: base.occurredAt,
          updatedAt: base.occurredAt,
        },
      });
      if (deleted)
        yield* projects.apply({
          ...base,
          type: "project.deleted",
          payload: { projectId, deletedAt: base.occurredAt },
        });
    }
    assert.equal(yield* projects.count, 2);
    assert.equal(yield* projects.count, (yield* projects.list()).length);
  }).pipe(
    Effect.provide(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
