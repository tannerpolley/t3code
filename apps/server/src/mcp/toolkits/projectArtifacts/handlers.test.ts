import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProjectArtifacts from "../../../project/ProjectArtifacts.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { ProjectArtifactsToolkit } from "./tools.ts";

it.effect(
  "lists, pins with agent attribution, and removes through the calling project's service",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("science");
      const explicitProject = ProjectId.make("other-project");
      const calls: unknown[] = [];
      const artifact: ProjectArtifact = {
        id: "paper",
        path: "paper.qmd",
        resolvedPath: "/science/paper.qmd",
        name: "paper.qmd",
        label: null,
        addedBy: "agent",
        available: true,
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "session",
          thread: {
            threadId: ThreadId.make("thread"),
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ ...liveThreadShell(ThreadId.make("thread")), projectId }),
        }),
        Layer.mock(ProjectArtifacts.ProjectArtifacts)({
          list: (id) =>
            Effect.sync(() => {
              calls.push(["list", id]);
              return [artifact];
            }),
          add: (input, addedBy) =>
            Effect.sync(() => {
              calls.push(["add", input, addedBy]);
              return artifact;
            }),
          remove: (input) =>
            Effect.sync(() => {
              calls.push(["remove", input]);
            }),
        }),
      );
      const toolkit = yield* ProjectArtifactsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const list = yield* toolkit
        .handle("t3_project_artifacts_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(list.at(-1)?.result).toEqual([artifact]);
      const add = yield* toolkit
        .handle("t3_project_artifacts_add", { path: "paper.qmd" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(add.at(-1)?.result).toEqual(artifact);
      yield* toolkit
        .handle("t3_project_artifacts_remove", { projectId: explicitProject, id: "paper" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(calls).toEqual([
        ["list", projectId],
        ["add", { projectId, path: "paper.qmd" }, "agent"],
        ["remove", { projectId: explicitProject, id: "paper" }],
      ]);
    }),
);
