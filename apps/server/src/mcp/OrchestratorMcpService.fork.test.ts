import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import type { DispatchModeRefusal } from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestration-v2/Orchestrator.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  NodeId,
  OrchestratorMcpTarget,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ModelRole,
  type ServerProvider,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { modelRoleStatuses } from "./delegateTaskTarget.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const decodeTarget = Schema.decodeUnknownEffect(OrchestratorMcpTarget);

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [
          {
            id: "transfer:delivered-original",
            type: "subagent_result",
            sourceThreadId: childThreadId,
            targetThreadId: parentThreadId,
            sourcePoint: { runId: childRunId },
          },
        ],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            status: "completed",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: {
          id: childThreadId,
          title: "Child task",
          forkedFrom: { type: "node", threadId: parentThreadId, nodeId: taskId },
        },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            delegatedTaskId: taskId,
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [
          {
            type: "subagent_spawn",
            sourceThreadId: parentThreadId,
            targetThreadId: childThreadId,
            targetRunId: childRunId,
          },
        ],
        messages: [],
        turnItems: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(null),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      runs: childProjection.runs.map((run) => ({
                        ...run,
                        delegatedTaskId: undefined,
                      })),
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.resultContextTransferId, "transfer:delivered-original");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const appOwnedTask = (id: string, threadId: ThreadId, childId: ThreadId) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        result: null,
        completionDelivery: { state: "pending" },
      });
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [appOwnedTask(taskId, parentThreadId, childThreadId)],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId, title: "Child task" },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");
  const modelRoleStatusNow = DateTime.toEpochMillis(
    DateTime.makeUnsafe("2026-10-12T12:00:00.000Z"),
  );
  const modelRoleStatusWeekMs = 7 * 24 * 60 * 60 * 1000;
  const modelRoleStatusResetAt = (timeLeft: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(modelRoleStatusNow + modelRoleStatusWeekMs * timeLeft));
  const modelRoleStatusCheckedAt = DateTime.formatIso(DateTime.makeUnsafe(modelRoleStatusNow));

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        lineage: { rootThreadId: parentThreadId, parentThreadId: null },
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId, title: "Child task" },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it("checks option selections independently for choices on the same model", () => {
    const model = "gpt-6.1-sol";
    const role: ModelRole = {
      id: "builder",
      name: "Builder",
      description: "",
      targets: [
        {
          providerInstanceId: codexInstanceId,
          model,
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
        {
          providerInstanceId: codexInstanceId,
          model,
          options: [{ id: "reasoningEffort", value: "invalid" }],
        },
      ],
    };
    const provider: ServerProvider = {
      ...providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model,
      }),
      models: [
        {
          slug: model,
          name: model,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
    };
    const statuses = modelRoleStatuses(
      [role],
      [provider],
      new Set([codexInstanceId]),
      modelRoleStatusNow,
    );
    assert.deepEqual(statuses[0]!.targets[0], { ...role.targets[0], unavailableReason: null });
    assert.equal(
      statuses[0]!.targets[1]!.unavailableReason,
      `Model ${model} on provider codex rejected options: Option reasoningEffort must be one of: medium, high.`,
    );
  });

  it("filters worker choices by provider, retaining fallback choices and orchestrators", () => {
    const claude = ProviderInstanceId.make("custom-claude");
    const blockedClaude = ProviderInstanceId.make("blocked-claude");
    const providers: ServerProvider[] = [
      providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "sol",
      }),
      providerSnapshot({
        instanceId: claude,
        driver: ProviderDriverKind.make("claudeAgent"),
        model: "opus",
      }),
      {
        ...providerSnapshot({
          instanceId: blockedClaude,
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "opus",
        }),
        auth: { status: "unauthenticated" },
      },
    ];
    const targets = [
      { providerInstanceId: codexInstanceId, model: "sol" },
      { providerInstanceId: blockedClaude, model: "opus" },
      { providerInstanceId: claude, model: "opus" },
    ] as const;
    const role: ModelRole = {
      id: "implementor-fast",
      name: "Implementor",
      description: "",
      targets,
    };
    const roles: ModelRole[] = [
      role,
      { ...role, id: "orchestrator" },
      { ...role, id: "checker", targets: [targets[0], targets[1]] },
    ];
    const capable = new Set(providers.map((provider) => provider.instanceId));
    const statuses = (mode: "mixed" | "claude" | "codex") =>
      modelRoleStatuses(roles, providers, capable, modelRoleStatusNow, mode);
    const mixed = statuses("mixed");
    const claudeOnly = statuses("claude");
    const codexOnly = statuses("codex");
    assert.deepEqual(
      claudeOnly[0]!.targets.map((target) => target.providerInstanceId),
      [claude],
    );
    assert.deepEqual(
      codexOnly[0]!.targets.map((target) => target.providerInstanceId),
      [codexInstanceId],
    );
    assert.deepEqual(claudeOnly[1], mixed[1]);
    assert.deepEqual(codexOnly[1], mixed[1]);
    assert.deepEqual(claudeOnly[2], mixed[2]);
    assert.deepEqual(
      mixed[0]!.targets.map((target) => target.providerInstanceId),
      [codexInstanceId, claude, blockedClaude],
    );
    assert.deepEqual(modelRoleStatuses(roles, providers, capable, modelRoleStatusNow), mixed);
  });

  it("keeps configured order unless headroom is below the threshold", () => {
    const instance = (id: string) => ProviderInstanceId.make(id);
    const configured = [
      "expired",
      "balanced",
      "unknown",
      "roomy",
      "missing-reset",
      "blocked",
    ] as const;
    const target = (id: string) => ({ providerInstanceId: instance(id), model: id });
    const weekly = (usedPercent: number, timeLeft?: number) => ({
      id: "weekly",
      kind: "weekly" as const,
      label: "Weekly",
      usedPercent,
      windowDurationMins: 7 * 24 * 60,
      ...(timeLeft === undefined ? {} : { resetsAt: modelRoleStatusResetAt(timeLeft) }),
    });
    const provider = (
      id: string,
      window?: ReturnType<typeof weekly>,
      unavailable = false,
    ): ServerProvider => ({
      ...providerSnapshot({
        instanceId: instance(id),
        driver: ProviderDriverKind.make("codex"),
        model: id,
      }),
      ...(unavailable ? { auth: { status: "unauthenticated" as const } } : {}),
      ...(window === undefined
        ? {}
        : {
            usageLimits: {
              checkedAt: modelRoleStatusCheckedAt,
              windows: [window],
            },
          }),
    });
    const roles: ReadonlyArray<ModelRole> = [
      {
        id: "builder",
        name: "Builder",
        description: "",
        targets: [
          target("expired"),
          target("balanced"),
          target("unknown"),
          target("roomy"),
          target("missing-reset"),
          target("blocked"),
        ],
      },
    ];
    const statuses = modelRoleStatuses(
      roles,
      [
        provider("expired", weekly(8, 0.98)),
        provider("balanced", weekly(40, 0.8)),
        provider("unknown"),
        provider("roomy", weekly(40, 0.2)),
        provider("missing-reset", weekly(10)),
        provider("blocked", weekly(0, 0.01), true),
      ],
      new Set(configured.map(instance)),
      modelRoleStatusNow,
    );
    const choices = statuses[0]!.targets;

    assert.deepEqual(
      choices.map((choice) => choice.model),
      ["expired", "unknown", "roomy", "missing-reset", "balanced", "blocked"],
    );
    assert.deepEqual(choices[0]!.weeklyUsage, {
      remainingPercent: 92,
      resetsAt: modelRoleStatusResetAt(0.98),
      pace: "ahead",
    });
    assert.equal(choices[1]!.weeklyUsage, undefined);
    assert.deepEqual(choices[4]!.weeklyUsage, {
      remainingPercent: 60,
      resetsAt: modelRoleStatusResetAt(0.8),
      pace: "ahead",
    });
    assert.include(choices[5]!.unavailableReason!, "not authenticated");

    const demoted = modelRoleStatuses(
      roles,
      [
        provider("expired", weekly(60, 0.8)),
        provider("balanced", weekly(40, 0.8)),
        provider("unknown"),
        provider("roomy", weekly(36, 0.8)),
        provider("missing-reset", weekly(10)),
        provider("blocked", weekly(0, 0.01), true),
      ],
      new Set(configured.map(instance)),
      modelRoleStatusNow,
    )[0]!.targets;
    assert.deepEqual(
      demoted.map((choice) => choice.model),
      ["unknown", "roomy", "missing-reset", "balanced", "expired", "blocked"],
    );
  });

  it("caps Sonnet's weekly headroom at the all-models allowance", () => {
    const claude = ProviderInstanceId.make("claude");
    const role: ModelRole = {
      id: "builder",
      name: "Builder",
      description: "",
      targets: [{ providerInstanceId: claude, model: "claude-sonnet-4-6" }],
    };
    const provider: ServerProvider = {
      ...providerSnapshot({
        instanceId: claude,
        driver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      }),
      usageLimits: {
        checkedAt: modelRoleStatusCheckedAt,
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 95,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: modelRoleStatusResetAt(0.5),
          },
          {
            id: "seven_day_sonnet",
            kind: "weekly",
            label: "Weekly · Sonnet",
            usedPercent: 20,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: modelRoleStatusResetAt(0.4),
          },
        ],
      },
    };
    const choice = modelRoleStatuses([role], [provider], new Set([claude]), modelRoleStatusNow)[0]!
      .targets[0]!;
    assert.equal(choice.weeklyUsage?.remainingPercent, 5);
  });

  it("ranks Claude choices by the tighter general or matching model-scoped weekly quota", () => {
    const claude = ProviderInstanceId.make("claude");
    const role: ModelRole = {
      id: "builder",
      name: "Builder",
      description: "",
      targets: [
        { providerInstanceId: claude, model: "claude-sonnet-4-6" },
        { providerInstanceId: claude, model: "claude-opus-4-6" },
        { providerInstanceId: claude, model: "claude-3-5-haiku" },
      ],
    };
    const provider: ServerProvider = {
      ...providerSnapshot({
        instanceId: claude,
        driver: ProviderDriverKind.make("claudeAgent"),
        model: "claude-opus-4-6",
      }),
      models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-3-5-haiku"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: null,
      })),
      usageLimits: {
        checkedAt: modelRoleStatusCheckedAt,
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 60,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: modelRoleStatusResetAt(0.5),
          },
          {
            id: "seven_day_opus",
            kind: "weekly",
            label: "Weekly · Opus",
            usedPercent: 95,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: modelRoleStatusResetAt(0.1),
          },
          {
            id: "seven_day_sonnet",
            kind: "weekly",
            label: "Weekly · Sonnet",
            usedPercent: 20,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: modelRoleStatusResetAt(0.4),
          },
        ],
      },
    };
    const choices = modelRoleStatuses([role], [provider], new Set([claude]), modelRoleStatusNow)[0]!
      .targets;
    const byModel = new Map(choices.map((choice) => [choice.model, choice.weeklyUsage]));

    assert.deepEqual(
      choices.map((choice) => choice.model),
      ["claude-sonnet-4-6", "claude-3-5-haiku", "claude-opus-4-6"],
    );
    assert.deepEqual(byModel.get("claude-opus-4-6"), {
      remainingPercent: 5,
      resetsAt: modelRoleStatusResetAt(0.1),
      pace: "on",
    });
    assert.deepEqual(byModel.get("claude-sonnet-4-6"), {
      remainingPercent: 40,
      resetsAt: modelRoleStatusResetAt(0.5),
      pace: "ahead",
    });
    assert.deepEqual(byModel.get("claude-3-5-haiku"), {
      remainingPercent: 40,
      resetsAt: modelRoleStatusResetAt(0.5),
      pace: "ahead",
    });
  });

  it.effect("lists the user's model roles, marking targets delegate_task would reject", () => {
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const target = (providerInstanceId: ProviderInstanceId, model: string) => ({
      providerInstanceId,
      model,
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    const modelRoles: ReadonlyArray<ModelRole> = [
      {
        id: "builder",
        name: "Builder",
        description: "Pick a suitable choice",
        targets: [
          target(codexInstanceId, "gpt-5.4"),
          target(codexInstanceId, "gpt-0"),
          target(ProviderInstanceId.make("ghost"), "gpt-5.4"),
          target(claudeInstanceId, "claude-sonnet-4-6"),
        ],
      },
    ];
    const providers: ReadonlyArray<ServerProvider> = [
      providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      }),
      {
        ...providerSnapshot({
          instanceId: claudeInstanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        }),
        auth: { status: "unauthenticated" },
      },
    ];
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const capabilities = yield* service.capabilities(scope);
      assert.deepEqual(
        capabilities.modelRoles,
        modelRoles.map((entry) => ({
          ...entry,
          targets: Arr.map(entry.targets, (choice, index) => ({
            ...choice,
            unavailableReason: [
              null,
              "Model gpt-0 is not advertised by provider codex.",
              "Provider instance ghost is not registered.",
              "Provider claudeAgent cannot run a child task: Provider is not authenticated.",
            ][index]!,
          })),
        })),
      );
    }).pipe(
      Effect.provide(
        layerOrchestratorService.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadRecords: () => Effect.succeed(parentProjection([])),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed(providers),
              }),
              adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, modelRoles }),
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect.each(["general", "checker", "test", "reviewer", "investigator"] as const)(
    "driver-only delegation inherits the checkout for %s and skips disabled instances",
    (role) =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: altInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        let delegated = false;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),

            isProviderInstanceEnabledForProject: ({ instanceId }) =>
              Effect.succeed(instanceId !== codexInstanceId),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              instanceId === codexInstanceId
                ? Effect.fail(
                    new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                      projectId,
                      instanceId,
                    }),
                  )
                : Effect.void,
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            role,
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-skip-disabled-1",
          });
          assert.equal(result.status, "running");
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            modelSelection: { instanceId: string; model: string };
            role: string;
            worktree?: unknown;
            task: string;
          };
          assert.equal(request.modelSelection.instanceId, altInstanceId);
          assert.equal(
            request.role,
            role === "general" ? "investigator" : role === "test" ? "checker" : role,
          );
          assert.isUndefined(request.worktree);
          assert.equal(
            request.task,
            role === "general"
              ? "Summarize the diff."
              : `Act as the ${role === "test" ? "Checker" : role[0]!.toUpperCase() + role.slice(1)} sub-agent for this task.\n\nSummarize the diff.`,
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "inherited-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-disabled-without-adapter",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(null),
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer(
              testCase.name === "explicit-disabled-without-adapter"
                ? [codexAltInstanceId]
                : [codexInstanceId, codexAltInstanceId],
            ),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target =
              testCase.name === "inherited-unavailable"
                ? undefined
                : testCase.explicit
                  ? ({
                      providerInstanceId:
                        testCase.selectedInstanceId === null
                          ? codexInstanceId
                          : testCase.selectedInstanceId,
                    } as const)
                  : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (
                testCase.name === "explicit-unavailable" ||
                testCase.name === "inherited-unavailable" ||
                testCase.name === "explicit-disabled-without-adapter"
              ) {
                const expectedMessage =
                  `Provider ${codexInstanceId} cannot run a child task: ` +
                  (testCase.name === "explicit-disabled-without-adapter"
                    ? "No V2 provider adapter is registered. "
                    : "") +
                  "Provider instance is disabled.";
                assert.include(error.message, expectedMessage);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `disabled-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(threadError.code, "provider_unavailable");
                assert.include(threadError.message, expectedMessage);
              }
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        }
      }),
  );

  it.effect(
    "inherits delegated options, merges overrides, and resets on explicit clearing or a new target",
    () =>
      Effect.gen(function* () {
        const peerId = ProviderInstanceId.make("codex-subscription-2");
        const driver = ProviderDriverKind.make("codex");
        const inherited = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        } as const;
        const override = [{ id: "reasoningEffort", value: "max" }] as const;
        const cases = [
          {
            name: "partial override",
            target: { options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
          },
          {
            name: "clear with array",
            target: { options: [] },
            expected: { ...inherited, options: [] },
          },
          {
            name: "clear with object",
            target: { options: {} },
            expected: { ...inherited, options: [] },
          },
          {
            name: "change model",
            target: { model: "other-model" },
            expected: { instanceId: codexInstanceId, model: "other-model" },
          },
          {
            name: "change provider with override",
            target: { providerInstanceId: peerId, options: { reasoningEffort: "max" } },
            expected: { instanceId: peerId, model: inherited.model, options: override },
          },
        ] as const;
        for (const testCase of cases) {
          const commands: Array<unknown> = [];
          const task = {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            providerInstanceId: testCase.expected.instanceId,
            model: testCase.expected.model,
            status: "running",
            result: null,
          };
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadShell: () => Effect.succeed(null),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                    : childProjection,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return {
                    sequence: 1,
                    storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                  } as never;
                }),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: codexInstanceId,
                  driver,
                  model: inherited.model,
                }),
                models: [inherited.model, "other-model"].map((model) => ({
                  slug: model,
                  name: model,
                  isCustom: false,
                  capabilities: null,
                })),
              },
              providerSnapshot({ instanceId: peerId, driver, model: inherited.model }),
            ]),
            adapterRegistryLayer([codexInstanceId, peerId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const capabilities = yield* service.capabilities(scope);
            assert.deepEqual(capabilities.inheritedOptions, inherited.options);
            yield* service.delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget(testCase.target),
              mode: "async",
              clientRequestId: testCase.name,
            });
            assert.deepEqual(
              (commands[0] as { modelSelection: unknown }).modelSelection,
              testCase.expected,
              testCase.name,
            );
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }
      }),
  );

  it.effect("refuses stuck-root recovery to a Supervised caller", () =>
    Effect.gen(function* () {
      const recover = () => Effect.die("A Supervised caller reached stuck-root recovery.");
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
        Effect.provide(
          layerOrchestratorService.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                ServerSettings.layerTest(),
                Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
                Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                  list: () => Effect.succeed([]),
                }),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                Layer.mock(IssueWorkService.IssueWorkService)({
                  cancelRequest: recover,
                  restoreRoot: recover,
                }),
              ),
            ),
          ),
        ),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:recovery"),
        requestNamespace: "client:recovery",
        thread: undefined,
        client: { sessionId: "recovery", label: "Claude Code", access: "approval-required" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const repository = {
        host: "github.com",
        repository: "owner/repo",
        projectId: ProjectId.make("project:recovery"),
        reason: "Stuck root",
        clientRequestId: CommandId.make("command:recovery"),
      };
      const cancelled = yield* mcp
        .cancelIssueRequest(scope, {
          ...repository,
          expectedRootThreadId: ThreadId.make("thread:stuck-root"),
          requestId: CommandId.make("command:stuck-start"),
        })
        .pipe(Effect.flip);
      const restored = yield* mcp
        .restoreRepositoryRoot(scope, {
          ...repository,
          repositoryId: "repository:recovery",
          expectedRootThreadId: ThreadId.make("thread:stuck-root"),
          expectedRevision: 1,
          targetThreadId: ThreadId.make("thread:replacement"),
        })
        .pipe(Effect.flip);
      assert.equal(cancelled.code, "runtime_mode_escalation_denied");
      assert.equal(restored.code, "runtime_mode_escalation_denied");
    }),
  );
});
