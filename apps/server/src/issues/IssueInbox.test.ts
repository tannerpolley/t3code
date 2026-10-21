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
import { isoSeconds } from "./IssueInboxWatcher.ts";
import * as IssueService from "./IssueService.ts";

const root = ThreadId.make("root-b");
const repo = { host: "github.com", repository: "acme/b" };
/** Minutes after the watcher starts at the test clock's epoch; negative is before watching. */
const at = (minute: number) => isoSeconds(minute * 60_000);
const amineMarker = sourceMarker({
  project: "amine",
  repository: "github.com/acme/a",
  thread: "thread-a",
});

type Item = Record<string, unknown>;
const issue = (number: number, body: string, extra: Item = {}): Item => ({
  id: 1000 + number,
  number,
  title: `Issue ${number}`,
  body,
  state: "open",
  user: { login: "owner", type: "User" },
  labels: [],
  milestone: null,
  created_at: at(1),
  updated_at: at(1),
  html_url: `https://github.com/acme/b/issues/${number}`,
  ...extra,
});
const comment = (id: number, number: number, body: string, extra: Item = {}): Item => ({
  id,
  body,
  user: { login: "owner", type: "User" },
  created_at: at(2),
  updated_at: at(2),
  html_url: `https://github.com/acme/b/issues/${number}#issuecomment-${id}`,
  issue_url: `https://api.github.com/repos/acme/b/issues/${number}`,
  ...extra,
});
const event = (id: number, kind: string, number: number, extra: Item = {}): Item => ({
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
  readonly method?: "POST" | "DELETE";
  readonly body?: unknown;
  readonly ifNoneMatch?: string;
}

/**
 * GitHub as the watcher reads it: `since` (exclusive, "updated after"), newest-first sorting,
 * small pages and ETags.
 */
function fakeGitHub(pageSize = 2) {
  const requests: Request[] = [];
  const data = {
    issues: [] as Item[],
    comments: [] as Item[],
    events: [] as Item[],
    milestones: [] as Item[],
  };
  const newest = (key: string) => (left: Item, right: Item) =>
    String(right[key]).localeCompare(String(left[key]));
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
                : {
                    id: 901,
                    html_url: "https://github.com/acme/b/issues/3#issuecomment-901",
                    body: (input.body as { body?: string }).body,
                    updated_at: at(5),
                  },
            ),
            etag: null,
            nextPage: null,
          };
        const [route, query = ""] = input.path.split("?");
        const params = new URLSearchParams(query);
        const since = params.get("since") ?? "";
        const list =
          route === "labels"
            ? [{ name: "external" }]
            : route === "milestones"
              ? data.milestones
              : route === "issues"
                ? data.issues
                    .filter((entry) => params.get("state") !== "open" || entry.state === "open")
                    .filter((entry) => String(entry.updated_at) > since)
                    .toSorted(newest("updated_at"))
                : route === "issues/comments"
                  ? data.comments
                      .filter((entry) => String(entry.updated_at) > since)
                      .toSorted(newest("updated_at"))
                  : data.events.toSorted((left, right) => Number(right.id) - Number(left.id));
        const page = Number(params.get("page") ?? "1");
        const body = JSON.stringify(list.slice((page - 1) * pageSize, page * pageSize));
        const etag = `"${input.path}:${body}"`;
        return input.ifNoneMatch === etag
          ? { status: 304, body: "", etag, nextPage: null }
          : { status: 200, body, etag, nextPage: page * pageSize < list.length ? page + 1 : null };
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
          return Effect.die("server stopped before recording the delivery");
        }
        return Effect.succeed({ sequence: dispatched.length, storedEvents: [] });
      }),
    getThreadShell: (threadId) =>
      Effect.succeed({
        id: threadId,
        projectId: ProjectId.make(threadId === "thread-in-b" ? "project-b" : "project-a"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId === "loose-thread" ? threadId : root,
        },
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

/** A transition T3 wrote to #`number`, with its request span in minutes after watching began. */
const recordReceipt = (
  number: number,
  kind: string,
  span: readonly [number, number],
  milestoneNumber: number | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO issue_inbox_write_receipts (host, repository, issue_number, kind, milestone_number, started_at, finished_at)
      VALUES ('github.com', 'acme/b', ${number}, ${kind}, ${milestoneNumber}, ${span[0] * 60_000}, ${span[1] * 60_000})`;
  });

const setup = (github = fakeGitHub(), threads = fakeThreads()) =>
  Effect.gen(function* () {
    yield* seedRepository;
    const inbox = yield* IssueInbox.make.pipe(
      Effect.provide(Layer.mergeAll(github.service, threads.service, projects)),
    );
    // The first poll starts watching from now; nothing earlier is reported.
    yield* inbox.pollDue;
    return { inbox, github, threads };
  });

const nextPoll = (inbox: IssueInbox.IssueInbox["Service"]) =>
  TestClock.adjust("2 minutes").pipe(Effect.andThen(inbox.pollDue));

const listed = (inbox: IssueInbox.IssueInbox["Service"]) =>
  inbox
    .list(repo)
    .pipe(
      Effect.map(({ events }) =>
        events.map((entry) => `${entry.kind} #${entry.issueNumber}`).toSorted(),
      ),
    );

it("classifies own, external and bot writes by marker and T3 records, never by author", () => {
  const classify = (body: string, author = { login: "owner", type: "User" }, ownRecord = false) =>
    classifyWrite({ body, author, repositoryKey: "github.com/acme/b", ownRecord });
  assert.deepEqual(classify(`Status\n<!-- t3-issue-status:github.com:42:7 -->`), {
    origin: "own",
  });
  assert.deepEqual(classify("Quoting <!-- t3-issue- by hand"), {
    origin: "external",
    sourceProject: null,
    marked: false,
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
  assert.deepEqual(classify("Bump", { login: "dependabot[bot]", type: "Bot" }), { origin: "bot" });
  assert.deepEqual(parseSourceMarker(amineMarker), {
    project: "amine",
    repository: "github.com/acme/a",
    thread: "thread-a",
  });
  assert.isTrue(isTagged({ body: "cc @orchestrator please", labels: [], marked: false }));
  assert.isFalse(isTagged({ body: "mail me@orchestrator.dev", labels: [], marked: false }));
  assert.isTrue(isTagged({ body: "", labels: ["Cross-Project"], marked: false }));
});

it.effect(
  "pages through every listing, re-reads an overlap, and records each external write once",
  () =>
    Effect.gen(function* () {
      const { inbox, github } = yield* setup();
      github.data.issues = [
        issue(5, `Amine needs a new parameter set.\n${amineMarker}`),
        issue(6, "Split from #5\n\n<!-- t3-issue-change:change-1:0 -->"),
        issue(7, "Typed by hand"),
      ];
      github.data.comments = [
        comment(1, 5, "I can take this."),
        comment(2, 5, "**T3 Code status: Working**\n<!-- t3-issue-status:github.com:42:1005 -->"),
        comment(3, 5, "Bumped", { user: { login: "github-actions[bot]", type: "Bot" } }),
        comment(4, 7, "Me too"),
      ];
      github.data.events = Array.from({ length: 5 }, (_, index) =>
        event(10 + index, "labeled", 7, { label: { name: `topic-${index}` } }),
      );
      yield* nextPoll(inbox);
      assert.deepEqual(yield* listed(inbox), [
        "comment #5",
        "comment #7",
        "issue_opened #5",
        "issue_opened #7",
        ...Array.from({ length: 5 }, () => "labeled #7"),
      ]);
      // Two pages of issues and comments, and three of events, all read.
      assert.equal(
        github.requests.filter((request) => request.path.startsWith("issues/events")).length,
        1 + 3,
      );

      // A comment written in the same second as the newest one read still lands.
      github.data.comments.push(comment(8, 5, "Late commit", { created_at: at(2) }));
      yield* nextPoll(inbox);
      assert.include(yield* listed(inbox), "comment #5");
      assert.equal((yield* listed(inbox)).filter((entry) => entry === "comment #5").length, 2);

      // Nothing changed: every page 1 answers 304 and nothing repeats.
      const before = github.requests.length;
      yield* nextPoll(inbox);
      assert.deepEqual(
        github.requests.slice(before).map((request) => request.ifNoneMatch !== undefined),
        [true, true, true],
      );
      assert.equal((yield* listed(inbox)).length, 10);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("labels each issue from another project once and never relabels it", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    github.data.issues = [issue(5, `New\n${amineMarker}`), issue(7, "By hand")];
    yield* nextPoll(inbox);
    const labelWrites = () =>
      github.requests.filter((request) => /^issues\/\d+\/labels$/u.test(request.path));
    assert.deepEqual(
      labelWrites().map((request) => [request.path, request.body]),
      [["issues/5/labels", { labels: ["external", "priority: high", "from:amine"] }]],
    );
    // The owner removes a label later; the next update does not put it back.
    github.data.issues = [issue(5, `New\n${amineMarker}`, { updated_at: at(4) })];
    yield* nextPoll(inbox);
    assert.equal(labelWrites().length, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a paused repository is not read, labeled or digested", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_repository_orchestration SET paused = 1`;
    const before = github.requests.length;
    github.data.issues = [issue(5, `New\n${amineMarker}`)];
    yield* nextPoll(inbox);
    assert.equal(github.requests.length, before);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("attributes an event to T3 only inside the request span of a matching receipt", () =>
  Effect.gen(function* () {
    const github = fakeGitHub();
    github.data.milestones = [
      { number: 1, title: "M1" },
      { number: 2, title: "M2" },
    ];
    const { inbox } = yield* setup(github);
    yield* recordReceipt(6, "closed", [3, 3.02]);
    yield* recordReceipt(5, "milestoned", [3, 3.02], 1);
    // T3 closed #8 and moved it to M1 too, but GitHub's events for those writes are never read.
    yield* recordReceipt(8, "closed", [3, 3.02]);
    yield* recordReceipt(8, "milestoned", [3, 3.02], 1);
    github.data.events = [
      // The owner closes #6 by hand two minutes before T3's close, after reopening it.
      event(10, "closed", 6, { created_at: at(1) }),
      event(11, "reopened", 6, { created_at: at(2) }),
      event(12, "closed", 6),
      // And reopens and closes it again five minutes after T3's close.
      event(13, "reopened", 6, { created_at: at(8) }),
      event(14, "closed", 6, { created_at: at(9) }),
      // Within the same second as T3's move to M1, the owner moves #5 to M2 and then removes M1.
      event(15, "milestoned", 5, { milestone: { title: "M2" } }),
      event(16, "milestoned", 5, { milestone: { title: "M1" } }),
      event(17, "demilestoned", 5, { milestone: { title: "M1" } }),
      // The owner's own closes of #8 before and after that write stay external, in either order.
      event(20, "closed", 8, { created_at: at(1) }),
      event(21, "reopened", 8, { created_at: at(2) }),
      event(22, "closed", 8, { created_at: at(9) }),
      event(23, "milestoned", 8, { milestone: { title: "M2" } }),
    ];
    yield* nextPoll(inbox);
    assert.deepEqual(yield* listed(inbox), [
      "closed #6",
      "closed #6",
      "closed #8",
      "closed #8",
      "demilestoned #5",
      "milestoned #5",
      "milestoned #8",
      "reopened #6",
      "reopened #6",
      "reopened #8",
    ]);
    const events = (yield* inbox.list(repo)).events;
    assert.equal(events.find((entry) => entry.kind === "milestoned")?.snippet, "Milestone: M2");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("reports a title rename with both titles", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    github.data.events = [event(10, "renamed", 4, { rename: { from: "Old", to: "New" } })];
    yield* nextPoll(inbox);
    const [renamed] = (yield* inbox.list(repo)).events;
    assert.deepEqual([renamed?.kind, renamed?.snippet], ["renamed", 'Renamed from "Old" to "New"']);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats an older issue carrying another project's marker as external once activity arrives",
  () =>
    Effect.gen(function* () {
      const { inbox, github } = yield* setup();
      // Opened by Amine's agent before B's orchestrator was watching; the owner comments now.
      // It already has two of its three receiver labels, but not `from:amine`.
      const marked = issue(3, `Please add Y.\n${amineMarker}`, {
        created_at: at(-60),
        updated_at: at(1),
        labels: [{ name: "external" }, { name: "priority: high" }],
      });
      github.data.issues = [marked];
      github.data.comments = [comment(1, 3, "On it.")];
      yield* nextPoll(inbox);
      const [entry] = (yield* inbox.list(repo)).events;
      assert.deepEqual(
        [entry?.kind, entry?.highPriority, entry?.sourceProject],
        ["comment", true, "amine"],
      );
      const labelWrites = () =>
        github.requests.filter((request) => request.path === "issues/3/labels");
      assert.deepEqual(
        labelWrites().map((request) => request.body),
        [{ labels: ["external", "priority: high", "from:amine"] }],
      );
      // Later activity does not relabel it.
      github.data.issues = [{ ...marked, updated_at: at(5) }];
      github.data.events = [event(10, "closed", 3, { created_at: at(5) })];
      yield* nextPoll(inbox);
      assert.equal(labelWrites().length, 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "tags log events on an older issue whose body mentions @orchestrator or another project's marker",
  () =>
    Effect.gen(function* () {
      const { inbox, github } = yield* setup();
      const before = { created_at: at(-60), updated_at: at(3) };
      github.data.issues = [
        issue(20, "Ping @orchestrator when this lands.", before),
        issue(21, `Please add Y.\n${amineMarker}`, before),
        issue(22, "Plain issue", before),
      ];
      github.data.events = [20, 21, 22].map((number) => event(number, "closed", number));
      yield* nextPoll(inbox);
      assert.deepEqual(
        (yield* inbox.list(repo)).events
          .map((entry) => [entry.issueNumber, entry.tagged])
          .toSorted(([left], [right]) => Number(left) - Number(right)),
        [
          [20, true],
          [21, true],
          [22, false],
        ],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an overflow inside the overlap window is reported once and never walked again", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    // A bulk change: 120 comments in the same minute, more than fifty pages of two.
    github.data.comments = Array.from({ length: 120 }, (_, index) =>
      comment(1000 + index, 7, `Bulk ${index}`),
    );
    yield* nextPoll(inbox);
    const missed = () =>
      inbox
        .list(repo)
        .pipe(
          Effect.map(
            ({ events }) => events.filter((entry) => entry.kind === "missed_activity").length,
          ),
        );
    assert.equal(yield* missed(), 1);
    github.data.comments.push(
      comment(2000, 7, "New after the bulk", { created_at: at(3), updated_at: at(3) }),
    );
    const before = github.requests.length;
    yield* nextPoll(inbox);
    assert.equal(yield* missed(), 1);
    assert.equal(
      github.requests.slice(before).filter((request) => request.path.startsWith("issues/comments"))
        .length,
      1,
    );
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM issue_inbox_events WHERE event_key = 'comment:2000'`,
      [{ count: 1 }],
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "skips ahead once with one tagged missed-activity entry when catch-up passes the page cap",
  () =>
    Effect.gen(function* () {
      const { inbox, github } = yield* setup();
      github.data.events = Array.from({ length: 120 }, (_, index) =>
        event(100 + index, "labeled", 7, { label: { name: `topic-${index}` } }),
      );
      github.data.issues = [issue(9, "Opened by hand meanwhile")];
      yield* nextPoll(inbox);
      const first = (yield* inbox.list(repo)).events;
      // Fifty pages of two, newest first; the oldest twenty are skipped.
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count, MIN(event_key) AS oldest FROM issue_inbox_events WHERE kind = 'labeled'`,
        [{ count: 100, oldest: "event:120" }],
      );
      assert.include(yield* listed(inbox), "issue_opened #9");
      assert.deepEqual(
        first
          .filter((entry) => entry.kind === "missed_activity")
          .map((entry) => [entry.tagged, entry.snippet]),
        [[true, "Missed some issue activity while T3 was offline; check GitHub."]],
      );
      // The cursor moved to the newest event: the next poll reads only what is new.
      github.data.events.push(event(500, "closed", 7, { created_at: at(5) }));
      const before = github.requests.length;
      yield* nextPoll(inbox);
      assert.equal(
        github.requests.slice(before).filter((request) => request.path.startsWith("issues/events"))
          .length,
        1,
      );
      const second = (yield* inbox.list(repo)).events;
      assert.equal(second.filter((entry) => entry.kind === "missed_activity").length, 1);
      assert.include(yield* listed(inbox), "closed #7");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "wakes the orchestrator with at most one queued digest per 15 minutes, only for new tagged events, across a restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const github = fakeGitHub();
      const threads = fakeThreads();
      const { inbox } = yield* setup(github, threads);
      const record = (key: string, number: number, tagged: boolean) =>
        sql`INSERT INTO issue_inbox_events (host, repository_id, repository, event_key, issue_number, issue_title, kind, author, source_project, tagged, high_priority, needs_triage, url, snippet, occurred_at)
          VALUES ('github.com', '42', 'acme/b', ${key}, ${number}, 'Issue', 'comment', 'owner', NULL, ${tagged ? 1 : 0}, 0, 0, 'https://github.com/acme/b/issues/1', 'Hi', ${at(1)})`;
      const commandIds = () => threads.dispatched.map((command) => String(command.commandId));

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

      // 16 minutes after the first digest the next one commits and dispatches, then the server
      // stops before recording the delivery.
      yield* TestClock.adjust("14 minutes");
      threads.failNext();
      yield* inbox.pollDue;
      yield* record("c", 63, true);
      const restarted = yield* IssueInbox.make.pipe(
        Effect.provide(Layer.mergeAll(github.service, threads.service, projects)),
      );
      yield* restarted.pollDue;
      const [, interrupted, retried] = threads.dispatched;
      // The same command id: the orchestrator's receipt replays it instead of sending twice.
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
  "mentions unread events once at the orchestrator's next turn start, never on a steer",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedRepository;
      yield* sql`INSERT INTO issue_inbox_events (host, repository_id, repository, event_key, issue_number, issue_title, kind, author, source_project, tagged, high_priority, needs_triage, url, snippet, occurred_at)
      VALUES ('github.com', '42', 'acme/b', 'opened:62', 62, 'New', 'issue_opened', 'owner', 'amine', 0, 1, 1, 'https://github.com/acme/b/issues/62', '', ${at(1)})`;
      const store = yield* InlineShellStore;
      const delivery = (threadId: ThreadId, id: string, turnStart = true) => ({
        threadId,
        deliveryId: id,
        runId: RunId.make(`run-${id}`),
        attemptId: null,
        providerTurnId: null,
        messageId: MessageId.make(`message-${id}`),
        text: "Carry on.",
        compact: false,
        turnStart,
      });
      assert.equal(
        yield* store.deliver(delivery(ThreadId.make("other"), "other"), Effect.succeed),
        "Carry on.",
      );
      assert.equal(
        yield* store.deliver(delivery(root, "steer", false), Effect.succeed),
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
    const github = fakeGitHub();
    const { inbox } = yield* setup(github);
    const cross = yield* inbox.post(ThreadId.make("thread-in-a"), {
      repository: "acme/b",
      title: "Need a parameter set",
      body: "Details.",
    });
    assert.isTrue(cross.crossProject);
    const marker = sourceMarker({
      project: "a",
      repository: "github.com/acme/a",
      thread: "thread-in-a",
    });
    assert.deepEqual(github.requests.find((request) => request.path === "issues")!.body, {
      title: "Need a parameter set",
      body: `Details.\n\n${marker}`,
      labels: ["external", "from:a", "priority: high"],
    });

    // Commenting on one of B's own issues marks the comment and labels that issue.
    yield* inbox.post(ThreadId.make("thread-in-a"), {
      repository: "acme/b",
      issueNumber: 3,
      body: "Can you also cover Z?",
    });
    assert.deepEqual(
      github.requests.slice(-2).map((request) => [request.path, request.body]),
      [
        ["issues/3/comments", { body: `Can you also cover Z?\n\n${marker}` }],
        ["issues/3/labels", { labels: ["external", "from:a", "priority: high"] }],
      ],
    );

    const own = yield* inbox.post(ThreadId.make("thread-in-b"), {
      repository: "acme/b",
      issueNumber: 3,
      body: "Own note.",
    });
    assert.deepEqual([own.crossProject, own.labels], [false, []]);
    assert.deepEqual(github.requests.at(-1), {
      ...repo,
      path: "issues/3/comments",
      method: "POST",
      body: { body: "Own note." },
    });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("the watcher reads a same-project t3_issue_post comment as the repository's own", () =>
  Effect.gen(function* () {
    const github = fakeGitHub();
    const { inbox } = yield* setup(github);
    yield* inbox.post(ThreadId.make("thread-in-b"), {
      repository: "acme/b",
      issueNumber: 3,
      body: "Own note.",
    });
    github.data.comments = [comment(901, 3, "Own note.", { created_at: at(5), updated_at: at(5) })];
    yield* nextPoll(inbox);
    assert.deepEqual(yield* listed(inbox), []);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("t3_issue_inbox serves only a repository orchestrator and its descendants", () =>
  Effect.gen(function* () {
    const { inbox } = yield* setup();
    const refused = yield* inbox
      .forCaller(ThreadId.make("loose-thread"), { action: "list" })
      .pipe(Effect.flip);
    assert.equal(refused.code, "invalid-request");
    const allowed = yield* inbox.forCaller(ThreadId.make("child-of-b"), { action: "list" });
    assert.deepEqual(allowed, { repository: "acme/b", unread: 0, events: [] });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
