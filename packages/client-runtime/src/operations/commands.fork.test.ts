import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ProjectMutation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { createProject } from "./commands.ts";

const layerTestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly projectionRequests?: ThreadId[];
  readonly advertiseServerResolvedCommandContext?: boolean;
  readonly advertiseThreadStop?: boolean;
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (requestInput: {
      readonly threadId: ThreadId;
    }) =>
      Effect.sync(() => {
        input.projectionRequests?.push(requestInput.threadId);
        return input.projection ?? v2Projection;
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launchInput: OrchestrationV2ThreadLaunchInput) =>
      Effect.sync(() => {
        input.launches?.push(launchInput);
        return {
          threadId: launchInput.threadId ?? v2ThreadId,
          projection: input.projection ?? v2Projection,
          resumed: false,
        };
      }),
    [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
      Effect.sync(() => {
        input.projects.push(mutation);
        return {
          id: mutation.projectId,
          title: mutation.type === "project.create" ? mutation.title : "Project",
          workspaceRoot:
            mutation.type === "project.create" ? mutation.workspaceRoot : "/workspace/project",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          deletedAt: null,
        };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: {
          repositoryIdentity: true,
          ...(input.advertiseThreadStop === true ? { threadStop: true } : {}),
          ...(input.advertiseServerResolvedCommandContext === false
            ? {}
            : { serverResolvedCommandContext: true }),
        },
      },
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("V2 environment commands", () => {
  it.effect("routes projects through the event-sourced project transport", () =>
    Effect.gen(function* () {
      const projects: ProjectMutation[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects });

      yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createWorkspaceRootIfMissing: true,
        sectionId: "personal",
        sidebarExpanded: true,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(projects).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createWorkspaceRootIfMissing: true,
          sectionId: "personal",
          sidebarExpanded: true,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );
});
