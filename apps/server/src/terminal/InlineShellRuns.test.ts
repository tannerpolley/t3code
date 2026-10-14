import { expect, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  INLINE_SHELL_OUTPUT_BYTES,
  type InlineShellRunInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { TerminalManager } from "./Manager.ts";
import { InlineShellRuns, layer } from "./InlineShellRuns.ts";
import { pendingInlineShellContext } from "../orchestration-v2/InlineShellContext.ts";
import { RunAttemptId, ProviderThreadId } from "@t3tools/contracts";

it.effect(
  "persists only capped completion output, replays it, shares it, and deduplicates a retried launch",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-inline-record");
      const projectId = ProjectId.make("project-inline-record");
      const instanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const iso = DateTime.formatIso(now);
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: iso,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Inline test",
          workspaceRoot: "/tmp/inline-test",
          defaultModelSelection: null,
          scripts: [],
          createdAt: iso,
          updatedAt: iso,
        },
      });
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("thread-created"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              id: threadId,
              createdBy: "user",
              creationSource: "web",
              projectId,
              title: "Inline test",
              providerInstanceId: instanceId,
              modelSelection: { instanceId, model: "test" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: "/tmp/inline-worktree",
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const launches: unknown[] = [];
      const terminalLayer = Layer.mock(TerminalManager)({
        subscribe: (callback) =>
          Effect.sync(() => {
            listener = callback;
            return () => {
              listener = null;
            };
          }),
        openCommand: (input) =>
          Effect.sync(() => {
            launches.push(input);
            return {
              threadId,
              terminalId: input.terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "running",
              pid: 42,
              history: "",
              exitCode: null,
              exitSignal: null,
              label: "test",
              updatedAt: iso,
            } satisfies TerminalSessionSnapshot;
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* InlineShellRuns;
        const input: InlineShellRunInput = {
          threadId,
          runId: "record",
          blockId: "message:0",
          command: "printf result; exit 7",
          language: "bash",
        };
        const running = yield* service.run(input);
        yield* service.run(input);
        expect(launches).toHaveLength(1);
        expect(launches[0]).toMatchObject({
          cwd: "/tmp/inline-worktree",
          env: {
            T3CODE_PROJECT_ROOT: "/tmp/inline-test",
            T3CODE_WORKTREE_PATH: "/tmp/inline-worktree",
          },
          command: { command: input.command, language: "bash" },
        });
        const emit = (event: TerminalEvent) =>
          Effect.suspend(() =>
            listener === null ? Effect.die("No terminal listener") : listener(event),
          );
        const output =
          Array.from({ length: 400 }, (_, n) => `line-${n}: ${"😀".repeat(60)}`).join("\n") + "\n";
        yield* emit({ threadId, terminalId: running.terminalId, type: "output", data: output });
        expect((yield* service.latest({ threadId, blockId: input.blockId }))?.output).toBe("");
        yield* emit({
          threadId,
          terminalId: running.terminalId,
          type: "exited",
          exitCode: 7,
          exitSignal: 0,
        });
        const saved = yield* service.latest({ threadId, blockId: input.blockId });
        expect(saved).toMatchObject({ command: input.command, status: "completed", exitCode: 7 });
        expect(saved?.completedAt).not.toBeNull();
        expect(saved?.durationMs).toBeGreaterThanOrEqual(0);
        expect(new TextEncoder().encode(saved!.output).length).toBeLessThanOrEqual(
          INLINE_SHELL_OUTPUT_BYTES,
        );
        expect(saved!.output).toContain("line-399:");
        expect(saved!.output).not.toContain("line-0:");
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const replay = yield* store.getThreadProjection(threadId);
        expect(replay.turnItems[0]?.type).toBe("system_notice");
        expect(
          pendingInlineShellContext(
            replay.turnItems,
            [],
            RunAttemptId.make("next"),
            ProviderThreadId.make("provider"),
          ),
        ).toContain("Exit code: 7");
        yield* service.run(input);
        expect(launches).toHaveLength(1);
        // A late duplicate lifecycle event cannot rewrite the persisted result.
        yield* emit({ threadId, terminalId: running.terminalId, type: "closed" });
        expect(yield* service.latest({ threadId, blockId: input.blockId })).toEqual(saved);
      }).pipe(Effect.provide(layer.pipe(Layer.provide(terminalLayer))));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(RuntimeLayer.layerEventSink, ProjectionStore.layer, ProjectStore.layer).pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
);
