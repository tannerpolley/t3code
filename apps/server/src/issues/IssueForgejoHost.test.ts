import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import { IssueDetailResult, IssueWorkRead, IssueRepositoriesResult } from "@t3tools/contracts";
import * as Forgejo from "./IssueForgejoHost.ts";
import { issueHostFor } from "./IssueHost.ts";
import { issueEligibility } from "./IssueEligibility.ts";

const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);
const decodeWork = Schema.decodeEffect(IssueWorkRead);
const decodeDetail = Schema.decodeEffect(IssueDetailResult);
const decodeRepositories = Schema.decodeEffect(IssueRepositoriesResult);

const host = "forge.example:3000";
const repository = "owner/repo";
const scope = { cwd: "/tmp", host, repository };
const date = "2026-10-28T10:00:00Z";
const milestone = {
  id: 39,
  title: "Pilot",
  state: "open",
  open_issues: 2,
  closed_issues: 1,
  due_on: null,
};
const repo = {
  id: 12,
  full_name: repository,
  owner: { login: "owner" },
  private: true,
  archived: false,
  fork: false,
  has_issues: true,
  open_issues_count: 2,
  open_pr_counter: 3,
};
const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number + 100,
  number,
  title: `Issue ${number}`,
  state: "open",
  html_url: `https://${host}/${repository}/issues/${number}`,
  body: "",
  user: { login: "ghost" },
  original_author: "migrated",
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [],
  milestone,
  comments: 1,
  created_at: date,
  updated_at: date,
  ...overrides,
});
function setup(respond: (path: string, method: string, body: unknown) => unknown, next?: string) {
  const calls: string[] = [];
  const layer = Layer.mock(ForgejoCli.ForgejoCli)({
    api: (input) =>
      Effect.gen(function* () {
        expect(input.host).toBe(host);
        calls.push(input.path);
        const value = respond(input.path, input.method ?? "GET", input.body);
        if (isForgejoCliError(value)) return yield* value;
        return {
          stdout: JSON.stringify(value),
          stderr:
            next && input.path.includes("page=1")
              ? `link: <https://${host}/api/v1/${next}>; rel="next"`
              : "",
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const make = Forgejo.make(
    {
      safeRepository: (_, value) => value,
      resolveScope: (_, input) => Effect.succeed({ ...scope, ...input }),
    },
    host,
  ).pipe(Effect.provide(layer));
  return { make, calls };
}
it.each([
  ["Part of #7 <!-- t3:parent=7 -->", 7],
  ["<!-- t3:parent=17 -->", 17],
  ["Part of #7", null],
  ["<!-- t3:parent=0 -->", null],
  ["<!-- t3:parent=9007199254740992 -->", null],
  ["<!-- t3:parent=7 --> <!-- t3:parent=8 -->", null],
])("reads a single valid parent marker: %s", (body, expected) => {
  expect(Forgejo.parseParentMarker(body)).toBe(expected);
});

it.effect("maps issue and milestone pages, preserves ports, and follows pagination", () =>
  Effect.gen(function* () {
    const fixture = setup(
      (path) =>
        path.includes("/milestones")
          ? [milestone]
          : [issue(7), issue(8, { pull_request: { merged: false } })],
      "repos/owner/repo/issues?page=2",
    );
    const transport = yield* fixture.make;
    const page = yield* transport.listIssuePage(scope, "all", 1, 39);
    expect(page).toMatchObject({
      items: [
        {
          number: 7,
          stateReason: null,
          author: { login: "migrated", avatarUrl: null },
          milestone: { number: 39 },
        },
      ],
      nextPage: 2,
    });
    expect(fixture.calls[0]).toBe(
      "repos/owner/repo/issues?type=issues&state=all&sort=recentupdate&milestones=39&limit=50&page=1",
    );
    const milestones = yield* transport.listMilestonePage(scope, "all", 2);
    expect(milestones).toMatchObject({
      items: [{ number: 39, url: `https://${host}/owner/repo/milestone/39` }],
      nextPage: null,
    });
    const github = { ...transport };
    expect(issueHostFor(host, github, new Map([[host, transport]]))).toBe(transport);
    expect(issueHostFor("forge.example", github, new Map([[host, transport]]))).toBe(github);
    expect(issueHostFor(host, github)).toBe(github);
  }),
);

it.effect(
  "reads parent markers, complete children, cross-repository dependencies and renamed status identities",
  () =>
    Effect.gen(function* () {
      const fixture = setup((path) => {
        if (path === "repositories/12" || path === "repos/owner/repo") return repo;
        if (path.includes("/dependencies"))
          return [issue(4, { state: "closed", repository: { id: 22, full_name: "other/lib" } })];
        if (path.includes("?type=issues"))
          return [
            issue(7),
            issue(8, { body: "Part of #7 <!-- t3:parent=7 -->", state: "closed" }),
            issue(9, { body: "mentions #7" }),
          ];
        return issue(Number(path.split("/").at(-1)), {
          body: path.endsWith("/8") ? "Part of #7 <!-- t3:parent=7 -->" : "",
        });
      });
      const transport = yield* fixture.make;
      const work = yield* transport.workRead({ ...scope, number: 8 });
      yield* decodeWork(work);
      expect(work).toMatchObject({
        issue: { id: "108", nodeId: "12/8", repositoryId: "12" },
        parent: { number: 7 },
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: true,
        blockedBy: [{ issue: { repository: "other/lib", nodeId: "22/4" }, state: "closed" }],
      });
      const parent = yield* transport.workRead({ ...scope, number: 7 });
      expect(parent.subIssues.map((child) => child.number)).toEqual([8]);
      const metadata = yield* transport.listMetadata(scope, [7], true);
      expect(metadata.get(7)).toMatchObject({
        subIssues: { total: 1, completed: 1 },
        relationshipsComplete: true,
      });
      const statuses = yield* transport.statuses(host, ["12/8"]);
      expect(statuses).toMatchObject([
        {
          nodeId: "12/8",
          repository,
          number: 8,
          stateReason: null,
          blockedBy: [{ state: "closed" }],
          pullRequests: [],
        },
      ]);
    }),
);

it.effect("maps migrated comments and deduplicated timeline PR references", () =>
  Effect.gen(function* () {
    const fixture = setup((path) => {
      if (path.includes("/dependencies")) return [];
      if (path.includes("/comments"))
        return [
          {
            body: "hello",
            original_author: "original",
            user: { login: "ghost" },
            created_at: date,
            html_url: `https://${host}/owner/repo/issues/7#comment-1`,
          },
        ];
      if (path.includes("/timeline"))
        return ["closes", "none"].map((action) => ({
          type: "issue_ref",
          ref_action: action,
          ref_issue: issue(11, {
            repository: { id: 22, full_name: "other/lib" },
            pull_request: {
              merged: true,
              draft: false,
              html_url: `https://${host}/other/lib/pulls/11`,
            },
          }),
        }));
      if (path.includes("?type=issues"))
        return [issue(8, { body: "<!-- t3:parent=7 -->", state: "closed" })];
      return issue(7);
    });
    const transport = yield* fixture.make;
    const detail = yield* transport.detail(
      { ...scope, number: 7 },
      { accountId: "1", viewer: "owner", credentialFingerprint: "test" },
    );
    yield* decodeDetail(detail);
    expect(detail.issue.subIssues).toEqual({ total: 1, completed: 1 });
    expect(detail.comments[0]?.author?.login).toBe("original");
    expect(detail.linkedPullRequests).toMatchObject([
      { repository: "other/lib", number: 11, state: "merged", closesIssue: true },
    ]);
  }),
);

it.effect("lists owned and organization repositories", () =>
  Effect.gen(function* () {
    const fixture = setup((path) =>
      path === "user"
        ? { id: 1, login: "owner" }
        : path.startsWith("user/orgs")
          ? [{ username: "team" }]
          : [repo],
    );
    const transport = yield* fixture.make;
    const repositories = yield* transport.repositories();
    yield* decodeRepositories(repositories);
    expect(repositories.repositories).toMatchObject([{ repository, openIssuesAndPullRequests: 5 }]);
    expect(repositories.repositories).toHaveLength(1);
  }),
);

it.effect("reads headerless full dependency pages before proving completeness", () =>
  Effect.gen(function* () {
    const fixture = setup((path) => {
      if (path === "repos/owner/repo") return repo;
      if (path.includes("/dependencies"))
        return path.endsWith("page=1")
          ? Array.from({ length: 50 }, (_, i) => issue(i + 100, { state: "closed" }))
          : [issue(150)];
      if (path.includes("?type=issues")) return [];
      return issue(7);
    });
    const transport = yield* fixture.make;
    const work = yield* transport.workRead({ ...scope, number: 7 });
    expect(work.blockersComplete).toBe(true);
    expect(work.blockedBy).toHaveLength(51);
    expect(work.blockedBy.at(-1)?.state).toBe("open");
    expect(issueEligibility(work)).toBe("blocked");
    expect(fixture.calls).toContain("repos/owner/repo/issues/7/dependencies?limit=50&page=2");
  }),
);

it.effect("keeps detail readable and work conservative when dependencies are disabled", () =>
  Effect.gen(function* () {
    const fixture = setup((path) => {
      if (path === "repositories/12" || path === "repos/owner/repo") return repo;
      if (path.includes("/dependencies"))
        return new ForgejoCli.ForgejoCliError({
          command: "fj",
          cwd: scope.cwd,
          detail: "Not Found",
          reason: "not-found",
          httpStatus: 404,
        });
      if (path.includes("/comments"))
        return [
          {
            body: "hello",
            created_at: date,
            html_url: `https://${host}/owner/repo/issues/7#comment-1`,
          },
        ];
      if (path.includes("/timeline") || path.includes("?type=issues")) return [];
      return issue(7, { body: "issue body" });
    });
    const transport = yield* fixture.make;
    const detail = yield* transport.detail(
      { ...scope, number: 7 },
      { accountId: "1", viewer: "owner", credentialFingerprint: "test" },
    );
    expect(detail.body).toBe("issue body");
    expect(detail.comments[0]?.body).toBe("hello");
    expect(detail.issue.relationshipsComplete).toBe(false);
    const work = yield* transport.workRead({ ...scope, number: 7 });
    expect(work.blockersComplete).toBe(false);
    expect(issueEligibility(work)).toBe("unknown");
    expect(yield* transport.statuses(host, ["12/7"]).pipe(Effect.flip)).toMatchObject({
      code: "invalid-response",
    });
  }),
);

it.effect("maps body, milestone clearing, state, labels and posted issue writes", () =>
  Effect.gen(function* () {
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    const fixture = setup((path, method, body) => {
      if (method !== "GET") {
        writes.push({ path, method, body });
        return { id: 107, number: 7, html_url: issue(7).html_url };
      }
      return [
        { id: 3, name: "bug" },
        { id: 4, name: "old" },
      ];
    });
    const transport = yield* fixture.make;
    const ref = { ...scope, number: 7 };
    yield* transport.updateBody({ ...ref, body: "new body" });
    yield* transport.setMilestone({ ...ref, milestoneNumber: 39 });
    yield* transport.setMilestone({ ...ref, milestoneNumber: null });
    yield* transport.setState({ ...ref, state: "closed" });
    yield* transport.setState({ ...ref, state: "open" });
    yield* transport.ensureLabels(scope, [
      { name: "BUG", color: "ff0000" },
      { name: "new", color: "#00aabb" },
    ]);
    yield* transport.setLabels(ref, ["bug"], ["OLD", "absent"]);
    yield* transport.postComment(ref, "hello");
    yield* transport.postIssue(scope, { title: "posted", body: "body", labels: ["BUG"] });
    expect(writes).toEqual([
      { path: "repos/owner/repo/issues/7", method: "PATCH", body: { body: "new body" } },
      { path: "repos/owner/repo/issues/7", method: "PATCH", body: { milestone: 39 } },
      { path: "repos/owner/repo/issues/7", method: "PATCH", body: { milestone: 0 } },
      { path: "repos/owner/repo/issues/7", method: "PATCH", body: { state: "closed" } },
      { path: "repos/owner/repo/issues/7", method: "PATCH", body: { state: "open" } },
      { path: "repos/owner/repo/labels", method: "POST", body: { name: "new", color: "#00aabb" } },
      { path: "repos/owner/repo/issues/7/labels", method: "POST", body: { labels: ["bug"] } },
      { path: "repos/owner/repo/issues/7/labels/4", method: "DELETE", body: undefined },
      { path: "repos/owner/repo/issues/7/comments", method: "POST", body: { body: "hello" } },
      {
        path: "repos/owner/repo/issues",
        method: "POST",
        body: { title: "posted", body: "body", labels: [3] },
      },
    ]);
  }),
);
it.effect("edits only the child's parent marker and refuses cross-repository links", () =>
  Effect.gen(function* () {
    let body = "Keep this text.\n\nPart of #3 <!-- t3:parent=3 -->\n\nKeep this too.";
    const fixture = setup((path, method, payload) => {
      if (path === "repos/owner/repo") return repo;
      if (method === "PATCH") {
        body = (payload as { body: string }).body;
        return issue(8, { body });
      }
      return issue(Number(path.split("/").at(-1)), { body });
    });
    const transport = yield* fixture.make;
    const child = yield* transport.resolveLinkedIssue({ ...scope, number: 8 });
    const parent = { ...child, number: 7 };
    yield* transport.setParent({ child, parent, action: "add" });
    expect(body).toBe("Keep this text.\n\nPart of #7 <!-- t3:parent=7 -->\n\nKeep this too.");
    yield* transport.setParent({ child, parent: { ...parent, number: 3 }, action: "remove" });
    expect(Forgejo.parseParentMarker(body)).toBe(7);
    yield* transport.setParent({ child, parent, action: "remove" });
    expect(body).toContain("Keep this text.");
    expect(body).toContain("Keep this too.");
    expect(body).not.toContain("t3:parent");
    const count = fixture.calls.length;
    expect(
      yield* transport
        .setParent({ child, parent: { ...parent, repository: "other/repo" }, action: "add" })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "unsupported" });
    expect(fixture.calls).toHaveLength(count);
  }),
);
it.effect("explains dependency-blocked close failures", () =>
  Effect.gen(function* () {
    const fixture = setup(
      () =>
        new ForgejoCli.ForgejoCliError({
          command: "fj",
          cwd: "/tmp",
          detail: "precondition",
          httpStatus: 412,
        }),
    );
    const transport = yield* fixture.make;
    const error = yield* transport
      .setState({ ...scope, number: 7, state: "closed" })
      .pipe(Effect.flip);
    expect(error.message).toContain("open dependencies");
  }),
);

it.effect("creates with a durable receipt and recovers by marker without duplicate writes", () =>
  Effect.gen(function* () {
    const marker = "<!-- t3-issue-change:key -->";
    let createdBody = "";
    let posts = 0;
    const fixture = setup((path, method, payload) => {
      if (path === "repos/owner/repo") return repo;
      if (method === "POST") {
        posts++;
        expect(payload).toMatchObject({ title: "new", milestone: 39 });
        createdBody = (payload as { body: string }).body;
        return issue(7, { body: createdBody });
      }
      return createdBody ? [issue(7, { body: createdBody })] : [];
    });
    const transport = yield* fixture.make;
    const input = { ...scope, title: "new", body: "text", milestoneNumber: 39, writeKey: "key" };
    let receipt = "";
    const created = yield* transport.createIssue({
      ...input,
      recover: false,
      onCreated: (issue) =>
        Effect.sync(() => {
          receipt = issue.nodeId;
        }),
    });
    expect(receipt).toBe("12/7");
    expect(created.body).toBe(`text\n\n${marker}`);
    expect(yield* transport.createIssue(input)).toEqual(created);
    createdBody = "";
    expect(yield* transport.createIssue(input).pipe(Effect.flip)).toMatchObject({
      createOutcome: "unresolved",
    });
    expect(posts).toBe(1);
  }),
);

it.effect("keeps a successful create receipt even when mutable fields are invalid", () =>
  Effect.gen(function* () {
    let receipt = "";
    const fixture = setup((path) =>
      path === "repos/owner/repo" ? repo : issue(7, { state: "invalid" }),
    );
    const transport = yield* fixture.make;
    const error = yield* transport
      .createIssue({
        ...scope,
        title: "new",
        body: "text",
        milestoneNumber: null,
        writeKey: "key",
        recover: false,
        onCreated: (issue) =>
          Effect.sync(() => {
            receipt = issue.nodeId;
          }),
      })
      .pipe(Effect.flip);
    expect(receipt).toBe("12/7");
    expect(error.createOutcome).toBe("uncertain");
  }),
);

it.effect(
  "reconciles managed comments by marker across pages and replaces a deleted status comment",
  () =>
    Effect.gen(function* () {
      const marker = "<!-- managed -->";
      const writes: string[] = [];
      let found = true;
      const fixture = setup((path, method, payload) => {
        if (method === "PATCH" && path.endsWith("/999"))
          return new ForgejoCli.ForgejoCliError({
            command: "fj",
            cwd: "/tmp",
            detail: "missing",
            reason: "not-found",
            httpStatus: 404,
          });
        if (method !== "GET") {
          writes.push(path);
          expect(payload).toEqual({ body: `status\n\n${marker}` });
          return { id: 51, html_url: issue(7).html_url };
        }
        if (!found) return [];
        return path.endsWith("page=1")
          ? Array.from({ length: 50 }, (_, i) => ({
              id: i + 1,
              body: "other",
              html_url: issue(7).html_url,
            }))
          : [{ id: 51, body: marker, html_url: issue(7).html_url }];
      });
      const transport = yield* fixture.make;
      const linked = {
        ...scope,
        repositoryId: "12",
        id: "107",
        nodeId: "12/7",
        number: 7,
        title: "issue",
        url: issue(7).html_url,
      };
      expect(
        yield* transport.writeManagedComment({
          issue: linked,
          marker,
          body: "status",
          operation: "closeout_create",
        }),
      ).toEqual({ commentId: "51" });
      expect(writes).toEqual([]);
      yield* transport.writeManagedComment({
        issue: linked,
        marker,
        body: "status",
        operation: "status_sync",
        commentId: "999",
      });
      expect(writes).toEqual(["repos/owner/repo/issues/comments/51"]);
      const limited = yield* transport.listComments(linked, { maxPages: 1 });
      expect(limited.complete).toBe(false);
      found = false;
      yield* transport.writeManagedComment({
        issue: linked,
        marker,
        body: "status",
        operation: "closeout_create",
      });
      expect(writes.at(-1)).toBe("repos/owner/repo/issues/7/comments");
    }),
);

it.effect(
  "reads all headerless activity pages, normalizes migrated actors, and maps close/reopen timelines",
  () =>
    Effect.gen(function* () {
      const fixture = setup((path) => {
        if (path.includes("/timeline"))
          return path.endsWith("page=1")
            ? Array.from({ length: 50 }, (_, i) => ({
                id: i + 1,
                type: "comment",
                created_at: date,
              }))
            : [
                { id: 101, type: "close", created_at: date },
                { id: 102, type: "reopen", created_at: date },
              ];
        if (path.includes("/issues/comments"))
          return path.endsWith("page=1")
            ? Array.from({ length: 50 }, (_, i) => ({
                id: i + 1,
                body: "hello",
                created_at: date,
                updated_at: date,
                original_author: "migrated",
                user: { login: "ghost" },
                issue_url: issue(7).html_url,
                html_url: `${issue(7).html_url}#issuecomment-${i + 1}`,
              }))
            : [
                {
                  id: 99,
                  body: "last page",
                  created_at: date,
                  updated_at: date,
                  issue_url: issue(7).html_url,
                  html_url: `${issue(7).html_url}#issuecomment-99`,
                },
              ];
        return path.endsWith("page=1")
          ? Array.from({ length: 50 }, (_, i) => issue(i + 1, { pull_request: { merged: false } }))
          : [issue(7)];
      });
      const transport = yield* fixture.make;
      const cursors = {
        issuesSince: date,
        commentsSince: date,
        eventsAfter: 0,
        issuesEtag: null,
        commentsEtag: null,
        eventsEtag: null,
      };
      const initial = yield* transport.activitySince(scope, { ...cursors, initial: true });
      expect(initial.eventsAfter).toBe(0);
      expect(fixture.calls).toEqual([]);
      const activity = yield* transport.activitySince(scope, cursors);
      expect(activity.issues.items).toMatchObject([
        { number: 7, milestone: { number: 39 }, user: { login: "migrated" } },
      ]);
      expect(activity.comments.items).toHaveLength(51);
      expect(activity.comments.items[0]?.user?.login).toBe("migrated");
      expect(activity.comments.items.at(-1)?.body).toBe("last page");
      expect(activity.stateChanges).toMatchObject({
        complete: true,
        items: [
          { id: 101, event: "closed", issue: { number: 7 } },
          { id: 102, event: "reopened", issue: { number: 7 } },
        ],
      });
      expect(activity.eventsAfter).toBe(102);
      expect(fixture.calls).toContain(
        `repos/owner/repo/issues/7/timeline?since=${encodeURIComponent(date)}&limit=50&page=2`,
      );
    }),
);
