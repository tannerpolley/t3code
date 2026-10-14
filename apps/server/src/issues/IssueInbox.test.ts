import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { InlineShellStore, layer as inlineShellLayer } from "../terminal/InlineShellStore.ts";
import * as IssueInbox from "./IssueInbox.ts";
import { classifyWrite, isTagged, parseSourceMarker, sourceMarker } from "./IssueInboxRules.ts";
import * as IssueService from "./IssueService.ts";

const root = ThreadId.make("root-b");
const at = (minute: number) => `1970-01-01T00:${String(minute).padStart(2, "0")}:00Z`;
const amineMarker = sourceMarker({
  project: "amine",
  repository: "github.com/acme/a",
  thread: "thread-a",
});

const issue = (number: number, body: string, extra: Record<string, unknown> = {}) => ({
  id: 1000 + number,
  number,
  title: `Issue ${number}`,
  body,
  user: { login: "owner", type: "User" },
  labels: [],
  milestone: null,
  created_at: at(1),
  updated_at: at(1),
  html_url: `https://github.com/acme/b/issues/${number}`,
  ...extra,
});
const comment = (
  id: number,
  number: number,
  body: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  body,
  user: { login: "owner", type: "User" },
  created_at: at(2),
  updated_at: at(2),
  html_url: `https://github.com/acme/b/issues/${number}#issuecomment-${id}`,
  issue_url: `https://api.github.com/repos/acme/b/issues/${number}`,
  ...extra,
});
const event = (id: number, kind: string, number: number, extra: Record<string, unknown> = {}) => ({
  id,
  event: kind,
  actor: { login: "owner", type: "User" },
  created_at: at(3),
  issue: {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/acme/b/issues/${number}`,
  },
  ...extra,
});

interface Request {
  readonly host: string;
  readonly repository: string;
  readonly path: string;
  readonly method?: "POST";
  readonly body?: unknown;
  readonly ifNoneMatch?: string;
}

/** GitHub as the watcher sees it. It ignores `since`, so every poll re-reads the boundary. */
function fakeGitHub() {
  const requests: Request[] = [];
  const data = { issues: [] as unknown[], comments: [] as unknown[], events: [] as unknown[] };
  const service = Layer.mock(IssueService.IssueService)({
    repositoryRest: (input) =>
      Effect.sync(() => {
        requests.push(input);
        if (input.method === "POST")
          return {
            status: 201,
            body: JSON.stringify(
              input.path === "issues"
                ? { id: 900, number: 77, html_url: "https://github.com/acme/a/issues/77" }
                : { id: 901, html_url: "https://github.com/acme/a/issues/3#issuecomment-901" },
            ),
            etag: null,
          };
        if (input.path.startsWith("labels"))
          return { status: 200, body: JSON.stringify([{ name: "external" }]), etag: null };
        const list = input.path.startsWith("issues?")
          ? data.issues
          : input.path.startsWith("issues/comments")
            ? data.comments
            : data.events;
        const body = JSON.stringify(list);
        const etag = `"${input.path.split("?")[0]}:${body.length}"`;
        return input.ifNoneMatch === etag
          ? { status: 304, body: "", etag }
          : { status: 200, body, etag };
      }),
  });
  return { requests, data, service };
}

function fakeThreads() {
  const dispatched: OrchestrationV2ServerCommand[] = [];
  let failures = 0;
  const service = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) =>
      Effect.suspend(() => {
        dispatched.push(command);
        if (failures > 0) {
          failures--;
          return Effect.die("server stopped mid-dispatch");
        }
        return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
      }),
    getThreadShell: (threadId) =>
      Effect.succeed({
        id: threadId,
        projectId: ProjectId.make(threadId === "thread-in-b" ? "project-b" : "project-a"),
        lineage: { parentThreadId: root, relationshipToParent: "subagent", rootThreadId: root },
      } as never),
  });
  return { dispatched, failNext: () => void failures++, service };
}

const projects = Layer.mock(ProjectService.ProjectService)({
  getById: (projectId) =>
    Effect.succeed(
      Option.some({
        title: projectId === "project-b" ? "B" : "Amine Thermodynamics",
        repositoryIdentity: {
          provider: "github",
          canonicalKey: projectId === "project-b" ? "github.com/acme/b" : "github.com/acme/a",
          displayName: projectId === "project-b" ? "acme/b" : "acme/a",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:x" },
        },
      } as never),
    ),
});

const seedRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${root}, 'project-b', 'B orchestrator', 'codex', 'full-access', 'default', ${at(0)}, ${at(0)}, '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
    VALUES ('github.com', '42', 'acme/b', ${root}, 'project-b', 'project', 'start', 1, 0, 4, 1, 1, ${at(0)}, ${at(0)})`;
});

const makeInbox = (
  github: ReturnType<typeof fakeGitHub>,
  threads: ReturnType<typeof fakeThreads>,
) =>
  IssueInbox.make.pipe(Effect.provide(Layer.mergeAll(github.service, threads.service, projects)));

const nextPoll = (inbox: IssueInbox.IssueInbox["Service"]) =>
  TestClock.adjust("2 minutes").pipe(Effect.andThen(inbox.pollDue));

it("classifies own, external and bot writes by marker and T3 records, never by author", () => {
  const classify = (body: string, author = { login: "owner", type: "User" }, ownRecord = false) =>
    classifyWrite({ body, author, repositoryKey: "github.com/acme/b", ownRecord });
  assert.deepEqual(classify(`Status\n<!-- t3-issue-status:github.com:42:7 -->`), {
    origin: "own",
  });
  assert.deepEqual(classify("Posted by B's own agent", undefined, true), { origin: "own" });
  assert.deepEqual(
    classify(sourceMarker({ project: "b", repository: "github.com/acme/b", thread: "t" })),
    { origin: "own" },
  );
  assert.deepEqual(classify(`Please look\n${amineMarker}`), {
    origin: "external",
    sourceProject: "amine",
    marked: true,
  });
  assert.deepEqual(classify("Typed by hand on GitHub"), {
    origin: "external",
    sourceProject: null,
    marked: false,
  });
  assert.deepEqual(classify("Bump", { login: "dependabot[bot]", type: "Bot" }), { origin: "bot" });
  assert.deepEqual(parseSourceMarker(amineMarker), {
    project: "amine",
    repository: "github.com/acme/a",
    thread: "thread-a",
  });
  assert.isTrue(isTagged({ body: "cc @orchestrator please", labels: [], marked: false }));
  assert.isFalse(isTagged({ body: "mail me@orchestrator.dev", labels: [], marked: false }));
  assert.isTrue(isTagged({ body: "", labels: ["Cross-Project"], marked: false }));
  assert.isTrue(isTagged({ body: "", labels: [], marked: true }));
});

it.effect(
  "records only external activity once, advances its cursors, and labels an external issue once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedRepository;
      const github = fakeGitHub();
      const inbox = yield* makeInbox(github, fakeThreads());
      // The first poll only starts the cursors: history from before watching is not news.
      yield* inbox.pollDue;
      assert.equal(
        (yield* inbox.list({ host: "github.com", repository: "acme/b" })).events.length,
        0,
      );

      github.data.issues = [
        issue(5, `Amine needs a new parameter set.\n${amineMarker}`),
        issue(6, "Split from #5\n\n<!-- t3-issue-change:change-1:0 -->"),
        issue(7, "Older issue", { created_at: "1969-12-31T00:00:00Z" }),
      ];
      github.data.comments = [
        comment(1, 5, "I can take this."),
        comment(2, 5, "**T3 Code status: Working**\n<!-- t3-issue-status:github.com:42:1005 -->"),
        comment(3, 5, "Bumped", { user: { login: "github-actions[bot]", type: "Bot" } }),
      ];
      yield* nextPoll(inbox);
      const first = (yield* inbox.list({ host: "github.com", repository: "acme/b" })).events;
      // Newest first; a comment on an external issue is high priority too.
      assert.deepEqual(
        first.map((entry) => [
          entry.kind,
          entry.issueNumber,
          entry.tagged,
          entry.sourceProject,
          entry.highPriority,
        ]),
        [
          ["comment", 5, false, null, true],
          ["issue_opened", 5, true, "amine", true],
        ],
      );
      assert.isTrue(first[1]!.needsTriage);
      const labelWrites = () =>
        github.requests.filter((request) => request.path === "issues/5/labels");
      assert.deepEqual(
        labelWrites().map((request) => request.body),
        [{ labels: ["external", "priority: high", "from:amine"] }],
      );
      // Missing labels are created first; `external` already exists.
      assert.deepEqual(
        github.requests
          .filter((request) => request.path === "labels" && request.method === "POST")
          .map((request) => (request.body as { name: string }).name),
        ["priority: high", "from:amine"],
      );

      // T3 closes #6 through an issue change; the owner closes #7 by hand.
      yield* sql`INSERT INTO issue_changes(change_id, requesting_thread_id, client_request_id, host, repository, issue_number, proposal_json, decision, status)
        VALUES ('change-2', ${root}, 'close-6', 'github.com', 'acme/b', 6, '{"operation":{"type":"state","state":"closed"}}', 'approved', 'succeeded')`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox(effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at, completed_at)
        VALUES ('effect:issue-change:change-2', 'issue-change:change-2', ${root}, 'issue.change', '{}', 'succeeded', ${at(3)}, ${at(3)}, ${at(3)}, ${at(3)})`;
      github.data.comments.push(comment(4, 5, "Edited later", { updated_at: at(4) }));
      github.data.events = [
        event(13, "closed", 7),
        event(12, "closed", 6),
        event(11, "labeled", 5, { label: { name: "priority: high" } }),
      ];
      yield* nextPoll(inbox);
      const issuesRequest = github.requests.findLast((request) =>
        request.path.startsWith("issues?"),
      );
      assert.include(issuesRequest!.path, `since=${encodeURIComponent(at(1))}`);
      assert.isDefined(issuesRequest!.ifNoneMatch);
      const second = (yield* inbox.list({ host: "github.com", repository: "acme/b" })).events;
      assert.deepEqual(second.map((entry) => [entry.kind, entry.issueNumber]).toSorted(), [
        ["closed", 7],
        ["comment", 5],
        ["edited", 5],
        ["issue_opened", 5],
      ]);
      assert.equal(labelWrites().length, 1);

      // Nothing changed: conditional reads answer 304 and add nothing.
      yield* nextPoll(inbox);
      assert.equal(
        (yield* inbox.list({ host: "github.com", repository: "acme/b" })).events.length,
        4,
      );
      assert.deepEqual(
        github.requests.slice(-3).map((request) => request.ifNoneMatch !== undefined),
        [true, true, true],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "wakes the orchestrator with at most one queued digest per 15 minutes, only for new tagged events, across a restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedRepository;
      const github = fakeGitHub();
      const threads = fakeThreads();
      const inbox = yield* makeInbox(github, threads);
      const record = (key: string, number: number, tagged: boolean) =>
        sql`INSERT INTO issue_inbox_events (host, repository_id, repository, event_key, issue_number, issue_title, kind, author, source_project, tagged, high_priority, needs_triage, url, snippet, occurred_at)
          VALUES ('github.com', '42', 'acme/b', ${key}, ${number}, 'Issue', 'comment', 'owner', NULL, ${tagged ? 1 : 0}, 0, 0, 'https://github.com/acme/b/issues/1', 'Hi', ${at(1)})`;
      const commandIds = () => threads.dispatched.map((command) => String(command.commandId));

      yield* inbox.pollDue;
      yield* record("untagged", 60, false);
      yield* nextPoll(inbox);
      assert.deepEqual(commandIds(), [], "untagged events never start a turn");

      yield* record("a", 61, true);
      yield* nextPoll(inbox);
      assert.equal(threads.dispatched.length, 1);
      const digest = threads.dispatched[0]!;
      assert.equal(digest.type, "message.dispatch");
      if (digest.type !== "message.dispatch") return;
      assert.deepEqual(digest.dispatchMode, { type: "queue_after_active" });
      assert.equal(digest.threadId, root);
      assert.equal(
        digest.text,
        "1 tagged external issue event since 00:01 UTC (b #61 comment). Read them with t3_issue_inbox.",
      );

      yield* record("b", 62, true);
      yield* nextPoll(inbox);
      assert.equal(threads.dispatched.length, 1, "throttled for 15 minutes");

      // 16 minutes after the first digest, the next one commits, then the server stops mid-dispatch.
      yield* TestClock.adjust("14 minutes");
      threads.failNext();
      yield* inbox.pollDue;
      yield* record("c", 63, true);
      const restarted = yield* makeInbox(github, threads);
      yield* restarted.pollDue;
      const [, interrupted, retried] = threads.dispatched;
      assert.equal(String(retried!.commandId), String(interrupted!.commandId));
      if (retried!.type === "message.dispatch") assert.include(retried!.text, "#62");
      assert.equal(threads.dispatched.length, 3, "#63 waits for the next window");

      yield* TestClock.adjust("16 minutes");
      yield* restarted.pollDue;
      assert.equal(threads.dispatched.length, 4);
      const last = threads.dispatched[3]!;
      if (last.type === "message.dispatch") {
        assert.include(last.text, "#63");
        assert.notInclude(last.text, "#62");
      }
      assert.equal(new Set(commandIds()).size, 3);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "mentions unread events once at the orchestrator's next turn, through the turn-start delivery",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedRepository;
      yield* sql`INSERT INTO issue_inbox_events (host, repository_id, repository, event_key, issue_number, issue_title, kind, author, source_project, tagged, high_priority, needs_triage, url, snippet, occurred_at)
        VALUES ('github.com', '42', 'acme/b', 'opened:62', 62, 'New', 'issue_opened', 'owner', 'amine', 0, 1, 1, 'https://github.com/acme/b/issues/62', '', ${at(1)})`;
      const store = yield* InlineShellStore;
      const delivery = (threadId: ThreadId, id: string) => ({
        threadId,
        deliveryId: id,
        runId: RunId.make(`run-${id}`),
        attemptId: null,
        providerTurnId: null,
        messageId: MessageId.make(`message-${id}`),
        text: "Carry on.",
        compact: false,
      });
      assert.equal(
        yield* store.deliver(delivery(ThreadId.make("other"), "other"), Effect.succeed),
        "Carry on.",
      );
      assert.equal(
        yield* store.deliver(delivery(root, "first"), Effect.succeed),
        "Issue inbox: 1 unread external issue event (b #62 opened from amine (needs triage)). Read them with t3_issue_inbox. Triage new external issues into a milestone; T3 admits nothing outside the selected milestones.\n\nCarry on.",
      );
      assert.equal(yield* store.deliver(delivery(root, "second"), Effect.succeed), "Carry on.");
    }).pipe(
      Effect.provide(inlineShellLayer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect("t3_issue_post marks and labels only writes to another project's repository", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const github = fakeGitHub();
    const inbox = yield* makeInbox(github, fakeThreads());
    const cross = yield* inbox.post(ThreadId.make("thread-in-a"), {
      repository: "acme/b",
      title: "Need a parameter set",
      body: "Details.",
    });
    assert.isTrue(cross.crossProject);
    const created = github.requests.find((request) => request.path === "issues")!;
    assert.deepEqual(created.body, {
      title: "Need a parameter set",
      body: `Details.\n\n${sourceMarker({ project: "a", repository: "github.com/acme/a", thread: "thread-in-a" })}`,
      labels: ["external", "from:a", "priority: high"],
    });

    const own = yield* inbox.post(ThreadId.make("thread-in-b"), {
      repository: "acme/b",
      issueNumber: 3,
      body: "Own note.",
    });
    assert.deepEqual([own.crossProject, own.labels], [false, []]);
    assert.deepEqual(github.requests.at(-1), {
      host: "github.com",
      repository: "acme/b",
      path: "issues/3/comments",
      method: "POST",
      body: { body: "Own note." },
    });
    // The watcher reads that unmarked comment as B's own.
    assert.deepEqual(yield* sql`SELECT item FROM issue_inbox_own_writes`, [
      { item: "comment:901" },
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
