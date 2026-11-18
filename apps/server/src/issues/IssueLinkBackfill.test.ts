import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as TrackerIssueService from "../issue/IssueService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IssueLinkBackfill from "./IssueLinkBackfill.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  openSession: () => Effect.die("No provider runs in a link backfill"),
} as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
const projectId = ProjectId.make("project:backfill");
const claim = (number: number, title: string) => ({
  host: "github.com",
  repository: "Owner/Repo",
  repositoryId: "repo",
  id: String(number),
  nodeId: `I_${number}`,
  number,
  url: `https://github.com/Owner/Repo/issues/${number}`,
  title,
});

function setup() {
  const reads: string[] = [];
  let titleReadsFail = true;
  const database = SqlitePersistence.layerMemory;
  const layer = Layer.mergeAll(
    database,
    ProviderReplayHarness.layerWithRegistry(
      { name: "issue-link-backfill" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
    Layer.mock(TrackerIssueService.IssueService)({
      detail: (ref) => {
        reads.push(ref.key);
        if (ref.key === "17")
          return Effect.fail(
            new IssueOperationError({ operation: "detail", detail: "gone", reason: "not-found" }),
          );
        return ref.key === "14" && titleReadsFail
          ? Effect.fail(new IssueOperationError({ operation: "detail", detail: "offline" }))
          : Effect.succeed({
              title: `Issue ${ref.key}`,
              url: `https://github.com/${ref.scope}/issues/${ref.key}`,
            } as never);
      },
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return {
    layer,
    reads,
    restoreTitleReads: () => {
      titleReadsFail = false;
    },
  };
}

const create = (id: string, linkedIssue?: ReturnType<typeof claim>) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: ThreadId.make(id),
      projectId,
      title: id,
      ...(linkedIssue === undefined ? {} : { linkedIssue }),
      modelSelection: { instanceId, model: "gpt-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );
// A claim from before claims carried links: its projection has one, its history never did.
const oldClaim = (id: string, linkedIssue: ReturnType<typeof claim>) =>
  Effect.gen(function* () {
    yield* create(id);
    yield* (yield* SqlClient.SqlClient)`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.linkedIssue', json(${JSON.stringify(linkedIssue)}))
      WHERE thread_id = ${id}`;
  });
const forgejo = "tnnrpolley21-ms-7c95.taila72856.ts.net:3000";
const links = (id: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator
      .getThreadShell(ThreadId.make(id))
      .pipe(Effect.map((shell) => (shell?.issues ?? []).map(({ key, title }) => [key, title]))),
  );

it.effect(
  "moves GitHub table rows and old claims onto thread links, keeping only rows worth retrying",
  () => {
    const h = setup();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* create("ordinary");
      yield* create("deleted");
      // A claim made now carries its link from creation, so a later unlink stays.
      yield* create("removed-claim", claim(16, "Removed"));
      assert.deepEqual(yield* links("removed-claim"), [["16", "Removed"]]);
      yield* orchestrator.dispatch({
        type: "thread.issue.unlink",
        commandId: CommandId.make("user-unlinks-claim"),
        threadId: ThreadId.make("removed-claim"),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "owner/repo",
        key: "16",
      });
      // An old claim on #15 whose thread later linked #99 still gets its own link.
      yield* oldClaim("old-claim", claim(15, "Claimed title"));
      yield* orchestrator.dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make("upstream-links-99"),
        threadId: ThreadId.make("old-claim"),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "owner/repo",
        key: "99",
        projectId,
        url: "https://github.com/owner/repo/issues/99",
        displayKey: "#99",
        title: "Issue 99",
        source: "agent",
      });
      yield* oldClaim("forgejo-claim", { ...claim(5, "Archived"), host: forgejo });
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET deleted_at = '2026-11-17T00:00:00.000Z' WHERE thread_id = 'deleted'`;
      for (const [host, number, thread] of [
        ["github.com", 13, "ordinary"],
        ["github.com", 14, "ordinary"],
        ["github.com", 17, "ordinary"],
        ["github.com", 15, "old-claim"],
        ["github.com", 13, "deleted"],
        ["github.com", 13, "missing"],
        [forgejo, 5, "ordinary"],
      ] as const)
        yield* sql`INSERT INTO issue_thread_links(host, repository, issue_number, thread_id)
          VALUES (${host}, 'owner/repo', ${number}, ${thread})`;
      const rows = sql<{
        thread_id: string;
        issue_number: number;
      }>`SELECT thread_id, issue_number FROM issue_thread_links ORDER BY thread_id, issue_number`;

      assert.deepEqual(yield* IssueLinkBackfill.run(), {
        linked: 2,
        rowsDone: 2,
        rowsDropped: 3,
        rowsKept: 1,
        otherHostRows: 1,
        otherHostClaims: 1,
      });
      assert.deepEqual(yield* links("ordinary"), [["13", "Issue 13"]]);
      assert.deepEqual(yield* links("old-claim"), [
        ["99", "Issue 99"],
        ["15", "Claimed title"],
      ]);
      assert.deepEqual(yield* links("removed-claim"), []);
      assert.deepEqual(yield* links("forgejo-claim"), []);
      // A claim's own title names it; each other GitHub issue is read once.
      assert.sameMembers(h.reads, ["13", "14", "17"]);
      // Only the transient failure is retried; the missing issue and other hosts are dropped.
      assert.deepEqual(yield* rows, [{ thread_id: "ordinary", issue_number: 14 }]);
      const oldClaimLink = (yield* orchestrator.getThreadShell(ThreadId.make("old-claim")))
        ?.issues?.[1];
      assert.equal(oldClaimLink?.url, "https://github.com/Owner/Repo/issues/15");
      const shell = yield* orchestrator.getThreadShell(ThreadId.make("ordinary"));
      assert.deepEqual(
        shell?.issues?.map(({ tracker, host, scope, projectId, url, displayKey, source }) => ({
          tracker,
          host,
          scope,
          projectId,
          url,
          displayKey,
          source,
        })),
        [
          {
            tracker: "github",
            host: "github.com",
            scope: "owner/repo",
            projectId,
            url: "https://github.com/owner/repo/issues/13",
            displayKey: "#13",
            source: "agent",
          },
        ],
      );

      h.restoreTitleReads();
      yield* IssueLinkBackfill.run();
      assert.deepEqual(yield* links("ordinary"), [
        ["13", "Issue 13"],
        ["14", "Issue 14"],
      ]);
      assert.deepEqual(yield* rows, []);

      const settled = yield* sink.latestSequence();
      yield* IssueLinkBackfill.run();
      assert.equal(yield* sink.latestSequence(), settled);

      // A row left behind by a crash after its link committed replays its receipt, even after
      // the user removed that link.
      yield* orchestrator.dispatch({
        type: "thread.issue.unlink",
        commandId: CommandId.make("user-unlinks-13"),
        threadId: ThreadId.make("ordinary"),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "owner/repo",
        key: "13",
      });
      yield* sql`INSERT INTO issue_thread_links(host, repository, issue_number, thread_id)
        VALUES ('github.com', 'owner/repo', 13, 'ordinary')`;
      const unlinked = yield* sink.latestSequence();
      yield* IssueLinkBackfill.run();
      assert.deepEqual(yield* links("ordinary"), [["14", "Issue 14"]]);
      assert.equal(yield* sink.latestSequence(), unlinked);
      assert.deepEqual(yield* rows, []);
    }).pipe(Effect.provide(h.layer));
  },
);
