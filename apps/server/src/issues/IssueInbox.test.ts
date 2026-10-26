import { assert, it } from "@effect/vitest";
import {
  IssueReadError,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as IssueInbox from "./IssueInbox.ts";
import { classifyWrite, parseSourceMarker, sourceMarker } from "./IssueInboxRules.ts";
import { isoSeconds } from "./IssueInboxWatcher.ts";
import * as IssueWorkService from "./IssueWorkService.ts";
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
  let identityError: IssueReadError | null = null;
  const requests: Request[] = [];
  const identityReads: Array<{ host: string; repository: string }> = [];
  const data = {
    issues: [] as Item[],
    comments: [] as Item[],
    events: [] as Item[],
    milestones: [] as Item[],
  };
  const newest = (key: string) => (left: Item, right: Item) =>
    String(right[key]).localeCompare(String(left[key]));
  const service = Layer.mock(IssueService.IssueService)({
    repositoryIdentity: (input) =>
      Effect.suspend(() => {
        identityReads.push(input);
        return identityError === null
          ? Effect.succeed({ ...input, repositoryId: input.repository })
          : Effect.fail(identityError);
      }),
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
  return {
    requests,
    identityReads,
    data,
    service,
    setIdentityError: (error: IssueReadError | null) => {
      identityError = error;
    },
  };
}

function fakeThreads(onDispatch: () => Effect.Effect<void> = () => Effect.void) {
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
        return onDispatch().pipe(Effect.as({ sequence: dispatched.length, storedEvents: [] }));
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

const projects = Layer.mergeAll(
  Layer.mock(IssueWorkService.IssueWorkService)({}),
  Layer.mock(ProjectService.ProjectService)({
    listShells: () => Effect.succeed([]),
    getById: (projectId) =>
      Effect.succeedSome({
        title: projectId === "project-b" ? "B" : "Amine Thermodynamics",
        repositoryIdentity: {
          provider: "github",
          canonicalKey: projectId === "project-b" ? "github.com/acme/b" : "github.com/acme/a",
          displayName: projectId === "project-b" ? "acme/b" : "acme/a",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:x" },
        },
      } as never),
  }),
);

const seedRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${root}, 'project-b', 'B orchestrator', 'codex', 'full-access', 'default', ${at(0)}, ${at(0)}, '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
    VALUES ('github.com', '42', 'acme/b', ${root}, 'project-b', 'project', 'start', 1, 0, 4, 1, 1, ${at(0)}, ${at(0)})`;
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

const setupDiscovery = (github = fakeGitHub(), count = 1) =>
  Effect.gen(function* () {
    const threads = fakeThreads();
    let repository: string | null = "acme/discovery";
    let present = true;
    const inbox = yield* IssueInbox.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          github.service,
          threads.service,
          Layer.mock(ProjectService.ProjectService)({
            listShells: () =>
              Effect.sync(() =>
                !present
                  ? []
                  : Array.from(
                      { length: count },
                      (_, index) =>
                        ({
                          id: ProjectId.make(`discovery-${index}`),
                          repositoryIdentity:
                            repository === null
                              ? null
                              : {
                                  provider: "github",
                                  canonicalKey: `github.com/${repository}-${index}`,
                                  displayName: count === 1 ? repository : `${repository}-${index}`,
                                  locator: {
                                    source: "git-remote",
                                    remoteName: "origin",
                                    remoteUrl: "git@github.com:x",
                                  },
                                },
                        }) as never,
                    ),
              ),
          }),
          Layer.mock(IssueWorkService.IssueWorkService)({
            repositoryStatus: () => Effect.succeed({ rootThreadId: null } as never),
          }),
        ),
      ),
    );
    yield* inbox.pollDue;
    return {
      inbox,
      github,
      setRepository: (value: string | null) => void (repository = value),
      setPresent: (value: boolean) => void (present = value),
    };
  });

it.effect("defers failed discovery through the pause and staggers retries", () =>
  Effect.gen(function* () {
    const github = fakeGitHub();
    github.setIdentityError(
      new IssueReadError({
        operation: "detail",
        code: "rate-limited",
        message: "Paused",
        retryAt: 60_000,
      }),
    );
    const { inbox } = yield* setupDiscovery(github, 2);
    assert.equal(github.identityReads.length, 2);
    for (let tick = 0; tick < 3; tick++) {
      yield* TestClock.adjust("5 seconds");
      yield* inbox.pollDue;
      assert.equal(github.identityReads.length, 2);
    }
    github.setIdentityError(null);
    yield* TestClock.setTime(59_999);
    yield* inbox.pollDue;
    assert.equal(github.identityReads.length, 2);
    yield* TestClock.adjust("1 millis");
    yield* inbox.pollDue;
    assert.equal(github.identityReads.length, 3);
    yield* TestClock.adjust("5 seconds");
    yield* inbox.pollDue;
    assert.equal(github.identityReads.length, 4);
    yield* inbox.pollDue;
    assert.equal(github.identityReads.length, 4);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "backs off discovery without a retry deadline and invalidates it on identity changes",
  () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      github.setIdentityError(
        new IssueReadError({
          operation: "detail",
          code: "inaccessible",
          message: "Unavailable",
        }),
      );
      const { inbox, setRepository, setPresent } = yield* setupDiscovery(github);
      for (let tick = 0; tick < 3; tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* inbox.pollDue;
        assert.equal(github.identityReads.length, 1);
      }
      yield* TestClock.setTime(15 * 60_000);
      yield* inbox.pollDue;
      assert.equal(github.identityReads.length, 2);
      setRepository("acme/renamed");
      yield* inbox.pollDue;
      assert.equal(github.identityReads.length, 3);
      setPresent(false);
      yield* inbox.pollDue;
      setPresent(true);
      github.setIdentityError(null);
      yield* inbox.pollDue;
      assert.equal(github.identityReads.length, 4);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("polls registered repositories every five minutes", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    const polls = () =>
      github.requests.filter((request) => request.path.startsWith("issues/events")).length;
    assert.equal(polls(), 1);
    yield* TestClock.adjust("2 minutes");
    yield* inbox.pollDue;
    assert.equal(polls(), 1);
    yield* TestClock.adjust("179999 millis");
    yield* inbox.pollDue;
    assert.equal(polls(), 1);
    yield* TestClock.adjust("1 millis");
    yield* inbox.pollDue;
    assert.equal(polls(), 2);
    yield* TestClock.adjust("5 minutes");
    yield* inbox.pollDue;
    assert.equal(polls(), 3);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("polls discovery-only repositories every fifteen minutes", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setupDiscovery();
    const polls = () =>
      github.requests.filter((request) => request.path.startsWith("issues/events")).length;
    assert.equal(polls(), 1);
    for (const advance of ["5 minutes", "5 minutes", "299999 millis"] as const) {
      yield* TestClock.adjust(advance);
      yield* inbox.pollDue;
      assert.equal(polls(), 1);
    }
    yield* TestClock.adjust("1 millis");
    yield* inbox.pollDue;
    assert.equal(polls(), 2);
    yield* TestClock.adjust("15 minutes");
    yield* inbox.pollDue;
    assert.equal(polls(), 3);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "reuses discovery identity across polls until the project's repository identity changes",
  () =>
    Effect.gen(function* () {
      const { inbox, github, setRepository, setPresent } = yield* setupDiscovery();
      for (let pass = 0; pass < 3; pass++) {
        yield* TestClock.adjust("15 minutes");
        yield* inbox.pollDue;
      }
      assert.deepEqual(github.identityReads, [
        { host: "github.com", repository: "acme/discovery" },
      ]);
      setRepository("acme/renamed");
      yield* TestClock.adjust("15 minutes");
      yield* inbox.pollDue;
      assert.deepEqual(github.identityReads, [
        { host: "github.com", repository: "acme/discovery" },
        { host: "github.com", repository: "acme/renamed" },
      ]);
      assert.isTrue(github.requests.some((request) => request.repository === "acme/renamed"));
      setRepository(null);
      yield* TestClock.adjust("15 minutes");
      yield* inbox.pollDue;
      setRepository("acme/renamed");
      yield* TestClock.adjust("15 minutes");
      yield* inbox.pollDue;
      assert.equal(github.identityReads.length, 3);
      // A removed project leaves the cache, so re-adding it reads its identity again.
      setPresent(false);
      yield* TestClock.adjust("15 minutes");
      yield* inbox.pollDue;
      setPresent(true);
      yield* TestClock.adjust("15 minutes");
      yield* inbox.pollDue;
      assert.equal(github.identityReads.length, 4);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const nextPoll = (inbox: IssueInbox.IssueInbox["Service"]) =>
  TestClock.adjust("5 minutes").pipe(Effect.andThen(inbox.pollDue));

const listed = (inbox: IssueInbox.IssueInbox["Service"]) =>
  inbox
    .list(repo)
    .pipe(
      Effect.map(({ events }) =>
        events.map((entry) => `${entry.kind} #${entry.issueNumber}`).toSorted(),
      ),
    );

it("only classifies another project's valid source marker as external, regardless of login", () => {
  const classify = (body: string, author = { login: "owner", type: "User" }) =>
    classifyWrite({ body, author, repositoryKey: "github.com/acme/b" });
  for (const body of [
    "Raw gh write",
    "By hand @orchestrator",
    "<!-- t3-issue-status:github.com:42:7 -->",
    "<!-- t3-source project=%zz repository=- thread=t -->",
    sourceMarker({ project: "b", repository: "GitHub.com/Acme/B", thread: "t" }),
  ]) {
    assert.deepEqual(classify(body), { origin: "own" });
  }
  assert.deepEqual(classify(`Please look\n${amineMarker}`), {
    origin: "external",
    sourceProject: "amine",
  });
  assert.deepEqual(classify(amineMarker, { login: "other-human", type: "User" }), {
    origin: "external",
    sourceProject: "amine",
  });
  assert.deepEqual(classify(sourceMarker({ project: "no-repo", repository: null, thread: "t" })), {
    origin: "external",
    sourceProject: "no-repo",
  });
  assert.deepEqual(classify(amineMarker, { login: "dependabot[bot]", type: "Bot" }), {
    origin: "bot",
  });
  assert.deepEqual(parseSourceMarker(amineMarker), {
    project: "amine",
    repository: "github.com/acme/a",
    thread: "thread-a",
  });
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
        comment(1, 5, `I can take this. ${amineMarker}`),
        comment(2, 5, "**T3 Code status: Working**\n<!-- t3-issue-status:github.com:42:1005 -->"),
        comment(3, 5, "Bumped", { user: { login: "github-actions[bot]", type: "Bot" } }),
        comment(4, 7, `Me too ${amineMarker}`),
      ];
      github.data.events = Array.from({ length: 5 }, (_, index) =>
        event(10 + index, "labeled", 7, { label: { name: `topic-${index}` } }),
      );
      yield* nextPoll(inbox);
      assert.deepEqual(yield* listed(inbox), ["comment #5", "comment #7", "issue_opened #5"]);
      // Two pages of issues and comments, and three of events, all read.
      assert.equal(
        github.requests.filter((request) => request.path.startsWith("issues/events")).length,
        1 + 3,
      );

      // A comment written in the same second as the newest one read still lands.
      github.data.comments.push(comment(8, 5, `Late commit ${amineMarker}`, { created_at: at(2) }));
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
      assert.equal((yield* listed(inbox)).length, 4);
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

it.effect(
  "unmarked writes and state, label, milestone and title changes never enter Inbox or wake it",
  () =>
    Effect.gen(function* () {
      const { inbox, github, threads } = yield* setup();
      github.data.issues = [
        issue(5, "By hand @orchestrator", { labels: [{ name: "cross-project" }] }),
        issue(6, "Raw gh issue"),
        issue(7, `Old marked issue ${amineMarker}`, { created_at: at(-60) }),
      ];
      github.data.comments = [comment(1, 7, "Unmarked comment on marked issue @orchestrator")];
      github.data.events = [
        "closed",
        "reopened",
        "labeled",
        "unlabeled",
        "milestoned",
        "demilestoned",
        "renamed",
      ].flatMap((kind, index) => [event(10 + index, kind, 5), event(20 + index, kind, 7)]);
      yield* nextPoll(inbox);
      assert.deepEqual(yield* listed(inbox), []);
      assert.deepEqual(threads.dispatched, []);
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
      github.data.comments = [comment(1, 3, `On it. ${amineMarker}`)];
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

it.effect("an overflow advances the cursor without inventing Inbox news", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    // A bulk change: 120 comments in the same minute, more than fifty pages of two.
    github.data.comments = Array.from({ length: 120 }, (_, index) =>
      comment(1000 + index, 7, `Bulk ${index}`),
    );
    yield* nextPoll(inbox);
    assert.deepEqual(yield* listed(inbox), []);
    github.data.comments.push(
      comment(2000, 7, `New after the bulk ${amineMarker}`, {
        created_at: at(3),
        updated_at: at(3),
      }),
    );
    const before = github.requests.length;
    yield* nextPoll(inbox);
    assert.deepEqual(yield* listed(inbox), ["comment #7"]);
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
      yield* TestClock.adjust("11 minutes");
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

it.effect("t3_issue_post refuses an unresolved repository identity before any GitHub request", () =>
  Effect.gen(function* () {
    const github = fakeGitHub();
    const inbox = yield* IssueInbox.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          github.service,
          fakeThreads().service,
          Layer.mock(IssueWorkService.IssueWorkService)({}),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ title: "B", repositoryIdentity: null } as never),
          }),
        ),
      ),
    );
    const refused = yield* inbox
      .post(ThreadId.make("thread-in-b"), {
        repository: "acme/b",
        title: "Own issue.",
        body: "Own note.",
      })
      .pipe(Effect.flip);
    assert.equal(refused.code, "orchestration-error");
    assert.equal(refused.message, "The project's repository identity is unavailable; retry.");
    assert.deepEqual(github.requests, []);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
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

it.effect("reading is not acknowledgment; mark_read releases only the acknowledged opening", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup();
    github.data.issues = [issue(5, `New ${amineMarker}`), issue(6, `New ${amineMarker}`)];
    github.data.comments = [comment(1, 5, `Comment ${amineMarker}`)];
    yield* nextPoll(inbox);
    const before = yield* inbox.list(repo);
    assert.deepEqual(before.pendingIssueNumbers?.toSorted(), [5, 6]);
    const opened = before.events.find(
      (event) => event.kind === "issue_opened" && event.issueNumber === 5,
    )!;
    const reply = before.events.find((event) => event.kind === "comment")!;
    const read = yield* inbox.forCaller(root, { action: "read", ids: [opened.id] });
    assert.equal(read.unread, 3);
    assert.deepEqual((yield* inbox.list(repo)).pendingIssueNumbers?.toSorted(), [5, 6]);
    yield* inbox.forCaller(root, { action: "mark_read", ids: [reply.id] });
    assert.deepEqual((yield* inbox.list(repo)).pendingIssueNumbers?.toSorted(), [5, 6]);
    yield* inbox.forCaller(root, { action: "mark_read", ids: [opened.id] });
    assert.deepEqual((yield* inbox.list(repo)).pendingIssueNumbers, [6]);
    assert.deepEqual(yield* inbox.markRead({ ...repo, ids: [opened.id] }), { marked: 0 });
    yield* inbox.markRead(repo);
    assert.deepEqual(yield* inbox.list(repo), { events: [], pendingIssueNumbers: [] });
    yield* nextPoll(inbox);
    assert.deepEqual((yield* inbox.list(repo)).pendingIssueNumbers, []);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("pending openings include issues beyond the event page", () =>
  Effect.gen(function* () {
    const { inbox, github } = yield* setup(fakeGitHub(100));
    github.data.issues = Array.from({ length: 101 }, (_, index) => issue(index + 1, amineMarker));
    yield* nextPoll(inbox);
    const listed = yield* inbox.list(repo);
    assert.equal(listed.events.length, 100);
    assert.equal(listed.pendingIssueNumbers?.length, 101);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("acknowledged events are excluded from throttled and retried digests", () =>
  Effect.gen(function* () {
    const { inbox, github, threads } = yield* setup();
    github.data.issues = [issue(5, amineMarker)];
    threads.failNext();
    yield* nextPoll(inbox);
    assert.equal(threads.dispatched.length, 1);
    yield* inbox.forCaller(root, { action: "mark_read" });
    yield* nextPoll(inbox);
    assert.equal(threads.dispatched.length, 1);
    github.data.comments = [comment(1, 5, amineMarker)];
    threads.failNext();
    yield* nextPoll(inbox);
    assert.equal(threads.dispatched.length, 2);
    yield* inbox.markRead(repo);
    yield* TestClock.adjust("16 minutes");
    yield* inbox.pollDue;
    assert.equal(threads.dispatched.length, 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "upgrade reclassifies unread legacy comments and retires unmarked news and stale digests",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 19 });
      yield* seedRepository;
      yield* sql`INSERT INTO issue_inbox_repositories (host, repository_id, watched_since, issues_since, comments_since, events_after)
      VALUES ('github.com', '42', ${at(0)}, ${at(10)}, ${at(10)}, 0)`;
      for (const [key, number, kind, source, read] of [
        ["opened:5", 5, "issue_opened", "amine", null],
        ["opened:6", 6, "issue_opened", null, null],
        ["opened:7", 7, "issue_opened", "amine", null],
        ["opened:8", 8, "issue_opened", "amine", null],
        ["comment:1", 5, "comment", "amine", null],
        ["comment:2", 5, "comment", "amine", null],
        ["comment:3", 5, "comment", "amine", at(4)],
        ["event:4", 5, "closed", "amine", null],
      ] as const) {
        yield* sql`INSERT INTO issue_inbox_events (host, repository_id, repository, event_key, issue_number, issue_title,
        kind, source_project, tagged, high_priority, needs_triage, url, snippet, occurred_at, read_at, noted_by)
        VALUES ('github.com', '42', 'acme/b', ${key}, ${number}, 'Issue', ${kind}, ${source}, 1, 1, 0,
          'https://github.com/acme/b/issues/5', '', ${at(2)}, ${read}, ${number === 7 ? "digest:2" : number === 8 ? "start:unseen" : "digest:1"})`;
      }
      yield* sql`INSERT INTO issue_inbox_digests (host, repository_id, text, created_at)
      VALUES ('github.com', '42', 'Stale digest', ${at(1)})`;
      yield* sql`INSERT INTO issue_inbox_digests (host, repository_id, text, created_at, delivered_at)
      VALUES ('github.com', '42', 'Delivered digest', ${at(-1)}, ${at(-1)})`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT text FROM issue_inbox_digests`, [
        { text: "Delivered digest" },
      ]);
      const github = fakeGitHub();
      github.data.comments = [
        comment(1, 5, "Unmarked on external issue"),
        comment(2, 5, amineMarker),
        comment(3, 5, amineMarker),
      ];
      const threads = fakeThreads();
      const inbox = yield* IssueInbox.make.pipe(
        Effect.provide(Layer.mergeAll(github.service, threads.service, projects)),
      );
      assert.deepEqual(yield* listed(inbox), [
        "issue_opened #5",
        "issue_opened #7",
        "issue_opened #8",
      ]);
      yield* inbox.pollDue;
      assert.deepEqual(yield* listed(inbox), [
        "comment #5",
        "issue_opened #5",
        "issue_opened #7",
        "issue_opened #8",
      ]);
      assert.deepEqual(((yield* inbox.list(repo)).pendingIssueNumbers ?? []).toSorted(), [5, 7, 8]);
      assert.deepEqual(threads.dispatched, []);
      yield* TestClock.adjust("16 minutes");
      yield* inbox.pollDue;
      assert.equal(threads.dispatched.length, 1);
      const digest = threads.dispatched[0]!;
      if (digest.type === "message.dispatch") {
        assert.include(digest.text, "#8", "a legacy turn-start note remains eligible");
        assert.notInclude(digest.text, "#7", "a successful legacy digest stays announced");
        assert.notInclude(digest.text, "Stale digest");
        assert.notInclude(digest.text, "#6");
        assert.notInclude(digest.text, "closed");
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("overlapping digest attempts retain new events and deliver once per 15 minutes", () =>
  Effect.gen(function* () {
    const accepted = yield* Deferred.make<void>();
    const dispatching = yield* Deferred.make<void>();
    let attempts = 0;
    const threads = fakeThreads(() =>
      ++attempts === 1
        ? Deferred.succeed(dispatching, undefined).pipe(Effect.andThen(Deferred.await(accepted)))
        : Effect.void,
    );
    const { inbox, github } = yield* setup(fakeGitHub(), threads);
    github.data.issues = [issue(5, amineMarker)];
    yield* TestClock.adjust("5 minutes");
    const first = yield* inbox.pollDue.pipe(Effect.forkScoped);
    yield* Deferred.await(dispatching);
    github.data.comments = [comment(1, 5, amineMarker, { created_at: at(6), updated_at: at(6) })];
    yield* TestClock.adjust("5 minutes");
    const second = yield* inbox.pollDue.pipe(Effect.forkScoped);
    yield* TestClock.adjust("0 millis");
    assert.lengthOf(threads.dispatched, 1, "only one dispatch is in flight");
    yield* Deferred.succeed(accepted, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.lengthOf(threads.dispatched, 1);
    assert.lengthOf((yield* inbox.list(repo)).events, 2, "the racing comment was polled");
    yield* TestClock.adjust("10 minutes");
    yield* inbox.pollDue;
    assert.lengthOf(threads.dispatched, 1, "cooldown starts at acceptance, not creation");
    yield* TestClock.adjust("5 minutes");
    yield* inbox.pollDue;
    assert.lengthOf(threads.dispatched, 2);
    const digest = threads.dispatched[1]!;
    if (digest.type === "message.dispatch") {
      assert.include(digest.text, "#5 comment");
      assert.notInclude(digest.text, "opened");
    }
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a delayed digest retry starts the next cooldown at successful delivery", () =>
  Effect.gen(function* () {
    const { inbox, github, threads } = yield* setup();
    github.data.issues = [issue(5, amineMarker)];
    threads.failNext();
    yield* nextPoll(inbox); // fails at t=5, leaves created_at=t=5
    yield* TestClock.adjust("16 minutes");
    yield* inbox.pollDue; // succeeds at t=21
    github.data.comments = [comment(1, 5, amineMarker, { created_at: at(22), updated_at: at(22) })];
    yield* nextPoll(inbox); // t=26: five minutes after the retry succeeded
    assert.equal(threads.dispatched.length, 2);
    yield* TestClock.adjust("5 minutes");
    yield* inbox.pollDue; // t=31: still before the cooldown ends
    assert.equal(threads.dispatched.length, 2);
    yield* TestClock.adjust("5 minutes");
    yield* inbox.pollDue; // t=36: polling resumes after the 15-minute cooldown
    assert.equal(threads.dispatched.length, 3);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      delivered_at: string;
    }>`SELECT delivered_at FROM issue_inbox_digests ORDER BY digest_id`;
    assert.equal(rows.length, 2);
    assert.equal(Date.parse(rows[0]!.delivered_at), Date.parse(at(21)));
    assert.equal(Date.parse(rows[1]!.delivered_at), Date.parse(at(36)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a digest accepted before a crash keeps its cooldown after its events are acknowledged",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let crash = true;
      // A real dispatch commits its receipt with the command; the server then stops before
      // recording delivered_at.
      const threads = fakeThreads(() =>
        Effect.gen(function* () {
          const id = String(threads.dispatched.at(-1)!.commandId);
          yield* sql`INSERT OR IGNORE INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
          VALUES (${id}, 'thread', ${root}, ${at(5)}, 1, 'accepted')`.pipe(Effect.orDie);
          if (crash) {
            crash = false;
            return yield* Effect.die("server stopped before recording the delivery");
          }
        }),
      );
      const { inbox, github } = yield* setup(fakeGitHub(), threads);
      github.data.issues = [issue(5, amineMarker)];
      yield* nextPoll(inbox); // t=5: accepted, then the crash
      const restarted = yield* IssueInbox.make.pipe(
        Effect.provide(Layer.mergeAll(github.service, threads.service, projects)),
      );
      yield* restarted.markRead(repo);
      yield* restarted.pollDue; // the emptied pending digest counts as delivered at t=5
      github.data.comments = [comment(1, 5, amineMarker, { created_at: at(6), updated_at: at(6) })];
      yield* nextPoll(restarted); // t=10
      assert.equal(threads.dispatched.length, 1, "accepted at t=5, so t=10 waits");
      yield* TestClock.adjust("10 minutes");
      yield* restarted.pollDue; // t=20
      assert.equal(threads.dispatched.length, 2);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
