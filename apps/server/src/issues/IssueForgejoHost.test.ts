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
function setup(respond: (path: string) => unknown, next?: string) {
  const calls: string[] = [];
  const layer = Layer.mock(ForgejoCli.ForgejoCli)({
    api: (input) =>
      Effect.gen(function* () {
        expect(input.host).toBe(host);
        expect(input.method ?? "GET").toBe("GET");
        calls.push(input.path);
        const value = respond(input.path);
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

it.effect(
  "lists owned and organization repositories and rejects writes and inbox without requests",
  () =>
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
      expect(repositories.repositories).toMatchObject([
        { repository, openIssuesAndPullRequests: 5 },
      ]);
      expect(repositories.repositories).toHaveLength(1);
      const calls = fixture.calls.length;
      for (const effect of [
        transport.updateBody({ ...scope, number: 7, body: "edit" }),
        transport.postComment({ ...scope, number: 7 }, "comment"),
        transport.listComments({ ...scope, number: 7 }),
        transport.activitySince(scope, {
          issuesSince: date,
          commentsSince: date,
          eventsAfter: 0,
          issuesEtag: null,
          commentsEtag: null,
          eventsEtag: null,
        }),
      ]) {
        const result = yield* Effect.result(effect);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: "unsupported", message: "Not supported on this issue host yet." },
        });
      }
      expect(fixture.calls).toHaveLength(calls);
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
