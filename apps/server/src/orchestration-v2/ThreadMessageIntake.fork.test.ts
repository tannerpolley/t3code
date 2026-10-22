// @effect-diagnostics nodeBuiltinImport:off

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  RunId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { dispatchCommand } from "./ThreadMessageIntake.ts";

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) => {
      captured.push(command);
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Stop after intake",
        }),
      );
    },
  });

it.effect("rejects client commands that bypass managed issue admission before dispatch", () => {
  const captured: OrchestrationV2ServerCommand[] = [];
  return Effect.gen(function* () {
    const issue = {
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repo:1",
      id: "issue:8",
      nodeId: "node:8",
      number: 8,
      title: "Managed issue",
      url: "https://github.com/tannerpolley/t3code/issues/8",
    };
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const commands: OrchestrationV2Command[] = [
      {
        type: "issue.work.start",
        commandId: CommandId.make("bypass:panel"),
        threadId: ThreadId.make("root"),
        issue,
        workerModelSelection: modelSelection,
        createdBy: "user",
        creationSource: "web",
      },
      {
        type: "delegated_task.request",
        commandId: CommandId.make("bypass:delegate"),
        parentThreadId: ThreadId.make("root"),
        parentRunId: RunId.make("run"),
        parentNodeId: NodeId.make("node"),
        issue,
        task: "Bypass start",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      },
    ];
    for (const command of commands) {
      const rejected = yield* dispatchCommand(command).pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure")
        expect(String(rejected.failure)).toContain("issue work service");
    }
    expect(captured).toHaveLength(0);
  }).pipe(Effect.provide(Layer.mergeAll(layerFailingDispatch(captured), layerIntakeTest)));
});
