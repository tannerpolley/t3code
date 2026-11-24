import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as OwnerDecisions from "../../issues/OwnerDecisions.ts";
import { ProjectArtifactsToolkit } from "./projectArtifacts/tools.ts";
import * as IssueLinks from "../../issues/IssueLinks.ts";
import * as IssueInbox from "../../issues/IssueInbox.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { expect, it } from "@effect/vitest";

import { EnvironmentId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { McpSchema, McpServer, Tool } from "effect/ai";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";

import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";

import { ProjectToolkit } from "./project/tools.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";

import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),

  Layer.provide(Layer.mock(OwnerDecisions.OwnerDecisions)({})),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";

const decodeRepositoryLimit = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.set_repository_worker_limit.parametersSchema,
);

it("publishes unique tool names with reference-free object-root inputs", () => {
  const names = new Set<string>();
  for (const toolkit of [
    OrchestratorToolkit,
    PreviewToolkit,
    WorktreeToolkit,
    ThreadToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    ProjectArtifactsToolkit,
    EnvironmentToolkit,
    PreviewControlsToolkit,
    DeviceToolkit,
    PullRequestsToolkit,
    HtmlToolkit,
  ]) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
      const definition = resolveT3McpToolDefinition(tool.name);
      expect(definition, tool.name).not.toBeNull();
      expect(
        definition?.labels.every((label) => label.trim().length > 0),
        tool.name,
      ).toBe(true);
      for (const name of [tool.name, `mcp__t3-code__${tool.name}`, `T3-code.${tool.name}`]) {
        expect(resolveT3McpToolPresentation(name)?.logo, name).toBe("t3-code");
        expect(resolveT3McpToolDefinition(name)?.summaryAction, name).not.toBeNull();
      }
    }
  }
  expect(names.has("set_repository_worker_limit")).toBe(true);
  const limitTool = OrchestratorToolkit.tools.set_repository_worker_limit;
  expect(
    decodeRepositoryLimit({
      host: "github.com",
      repository: "owner/repo",
      readOnlyLimit: 4,
      expectedRevision: 1,
      clientRequestId: "limit-read-only",
    }),
  ).toHaveProperty("readOnlyLimit", 4);
  expect(limitTool.description).toContain("readOnlyLimit");
  expect(names.has("t3_thread_launch")).toBe(true);
  expect(names.has("t3_thread_start")).toBe(false);
  for (const name of ["request_owner_decision", "list_owner_decisions", "withdraw_owner_decision"])
    expect(names.has(name)).toBe(true);
  expect(names.has("choose_owner_decision")).toBe(false);
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

it.effect("hides issue posting from a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const error = yield* server
      .callTool({
        name: "t3_issue_post",
        arguments: { repository: "owner/repo", title: "Issue", body: "Details" },
      })
      .pipe(
        Effect.flip,
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(error.message).toContain("Tool 't3_issue_post' not found");
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
        Layer.provide(Layer.mock(IssueLinks.IssueLinks)({})),
        Layer.provide(Layer.mock(IssueInbox.IssueInbox)({})),
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);
