import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import {
  IssueDetailResult,
  IssueWorkRead,
  IssueRepositoriesResult,
  IssueRepositoryRef,
} from "@t3tools/contracts";
import { issueEligibility } from "./IssueEligibility.ts";
import * as GitLab from "./IssueGitLabHost.ts";

const decodeIssueDetailResult = Schema.decodeEffect(IssueDetailResult);
const decodeIssueWorkRead = Schema.decodeEffect(IssueWorkRead);
const decodeIssueRepositoriesResult = Schema.decodeEffect(IssueRepositoriesResult);
const decodeIssueRepositoryRef = Schema.decodeEffect(IssueRepositoryRef);
const host = "gitlab.example:8443";
const repository = "group/subgroup/project";
const scope = { cwd: "/tmp", host, repository };
const base = "projects/group%2Fsubgroup%2Fproject";
const date = "2026-10-28T10:00:00Z";
// GitLab REST v4 response shapes, reduced to the fields this adapter consumes.
const milestone = { id: 39, iid: 3, title: "Pilot", state: "active", due_date: "2026-11-30" };
const project = {
  id: 12,
  path_with_namespace: repository,
  web_url: `https://${host}/${repository}`,
  namespace: { full_path: "group/subgroup", kind: "group" },
  visibility: "private",
  archived: false,
  issues_enabled: true,
  open_issues_count: 2,
  last_activity_at: date,
};
const issue = (iid: number, overrides: Record<string, unknown> = {}) => ({
  id: iid + 100,
  iid,
  project_id: 12,
  title: `Issue ${iid}`,
  state: "opened",
  web_url: `https://${host}/${repository}/-/issues/${iid}`,
  description: "",
  author: { username: "alice", avatar_url: null },
  assignees: [],
  labels: ["bug"],
  milestone,
  user_notes_count: 1,
  created_at: date,
  updated_at: date,
  closed_at: null,
  ...overrides,
});
const note = {
  id: 51,
  body: "hello",
  author: { username: "alice", avatar_url: null },
  system: false,
  created_at: date,
  updated_at: date,
};
const isCliError = Schema.is(GitLabCli.GitLabCliError);
const mr = { state: "merged", target_branch: "main", source_branch: "fix", sha: "abc" };
function setup(respond: (path: string, method: string, body: unknown) => unknown) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const layer = Layer.mock(GitLabCli.GitLabCli)({
    execute: (input) =>
      Effect.gen(function* () {
        const path = input.args[3]!;
        const methodIndex = input.args.indexOf("--method");
        const method = methodIndex < 0 ? "GET" : input.args[methodIndex + 1]!;
        const body: unknown = input.stdin ? JSON.parse(input.stdin) : undefined;
        expect(input.host).toBe(host);
        calls.push({ path, method, body });
        const response = respond(path, method, body);
        if (isCliError(response)) return yield* response;
        return {
          stdout: JSON.stringify(response),
          stderr: "",
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const context = {
    safeRepository: (_: string, value: string) => value,
    resolveScope: (_: unknown, input: { host: string; repository: string }) =>
      Effect.succeed({ ...scope, ...input }),
  };
  return { make: GitLab.make(context, host).pipe(Effect.provide(layer)), calls };
}
it.effect("maps nested project paths, iid identities, pagination and milestone IDs", () =>
  Effect.gen(function* () {
    const fixture = setup((path) =>
      path === "user"
        ? { id: 1, username: "alice" }
        : path.startsWith("projects?")
          ? [project]
          : path.includes("/milestones/39/issues")
            ? [issue(7), issue(8, { state: "closed" })]
            : path.includes("/milestones?iids[]=3")
              ? [milestone]
              : path.includes("/milestones?")
                ? [milestone]
                : Array.from({ length: 50 }, (_, i) => issue(i + 1)),
    );
    const transport = yield* fixture.make;
    const page = yield* transport.listIssuePage(scope, "open", 1, 3);
    if ("notModified" in page) throw new Error("Unexpected cached response");
    expect({ ...page, items: page.items.slice(0, 1) }).toMatchObject({
      items: [
        {
          number: 1,
          state: "open",
          author: { login: "alice" },
          labels: [{ name: "bug" }],
          milestone: { number: 3 },
        },
      ],
      nextPage: 2,
    });
    expect(fixture.calls[1]?.path).toBe(
      `${base}/issues?scope=all&state=opened&order_by=updated_at&sort=desc&milestone=Pilot&per_page=50&page=1`,
    );
    const milestones = yield* transport.listMilestonePage(scope, "open", 1);
    expect(milestones).toMatchObject({
      items: [
        {
          number: 3,
          openCount: 1,
          closedCount: 1,
          dueAt: "2026-11-30T00:00:00Z",
          url: `https://${host}/${repository}/-/milestones/3`,
        },
      ],
    });
    yield* decodeIssueRepositoriesResult(yield* transport.repositories());
    yield* decodeIssueRepositoryRef({ host, repository });
  }),
);
it.effect("reads marker hierarchy and comments, and replaces and removes parents", () =>
  Effect.gen(function* () {
    const fixture = setup((path) =>
      path === base
        ? project
        : path.includes("/notes?")
          ? [note, { ...note, id: 52, system: true }]
          : path.includes("/issues?")
            ? [
                issue(7),
                issue(8, { description: "Part of #7 <!-- t3:parent=7 -->", state: "closed" }),
              ]
            : path.endsWith("/issues/7")
              ? issue(7)
              : issue(8, { description: "text\n\nPart of #7 <!-- t3:parent=7 -->" }),
    );
    const transport = yield* fixture.make;
    const ref = { ...scope, number: 8 };
    const work = yield* transport.workRead(ref);
    yield* decodeIssueWorkRead(work);
    expect(work).toMatchObject({
      issue: { number: 8, id: "108", nodeId: "12/8" },
      parent: { number: 7 },
      blockersComplete: true,
    });
    expect(issueEligibility(work)).toBe("eligible");
    const detail = yield* transport.detail(ref, {
      accountId: "1",
      viewer: "alice",
      credentialFingerprint: "test",
    });
    yield* decodeIssueDetailResult(detail);
    expect(detail.comments).toHaveLength(1);
    expect(detail.issue.relationshipsComplete).toBe(true);
    const child = work.issue;
    yield* transport.setParent({
      child,
      parent: { ...child, id: "109", number: 9 },
      action: "add",
    });
    expect(fixture.calls.at(-1)?.body).toEqual({
      description: "text\n\nPart of #9 <!-- t3:parent=9 -->",
    });
    yield* transport.setParent({
      child,
      parent: { ...child, id: "107", number: 7 },
      action: "remove",
    });
    expect(fixture.calls.at(-1)?.body).toEqual({ description: "text\n\n" });
    expect(
      (yield* transport
        .setBlockedBy({ issue: child, blocker: { ...child, id: "107" }, action: "add" })
        .pipe(Effect.flip)).code,
    ).toBe("unsupported");
  }),
);
it.effect(
  "translates writes, recovers creates without retrying, and preserves uncertain receipts",
  () =>
    Effect.gen(function* () {
      const fixture = setup((path, method) =>
        path === base
          ? project
          : path.includes("/milestones?iids[]=3")
            ? [milestone]
            : path.endsWith("/labels?per_page=50&page=1")
              ? [{ name: "bug" }]
              : path.includes("/notes")
                ? note
                : method === "POST"
                  ? issue(8, { description: "body\n\n<!-- t3-issue-change:key -->" })
                  : path.includes("/issues?")
                    ? [issue(8, { description: "body\n\n<!-- t3-issue-change:key -->" })]
                    : issue(8),
      );
      const transport = yield* fixture.make;
      const input = {
        ...scope,
        title: "new",
        body: "body",
        milestoneNumber: 3,
        writeKey: "key",
        recover: false,
      };
      let receipt = "";
      const created = yield* transport.createIssue({
        ...input,
        onCreated: (ref) =>
          Effect.sync(() => {
            receipt = ref.nodeId;
          }),
      });
      expect(receipt).toBe("12/8");
      expect(created.issue.number).toBe(8);
      expect(fixture.calls.find((call) => call.method === "POST")?.body).toEqual({
        title: "new",
        description: "body\n\n<!-- t3-issue-change:key -->",
        milestone_id: 39,
      });
      yield* transport.createIssue({ ...input, recover: true });
      expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      const missing = yield* transport
        .createIssue({ ...input, writeKey: "missing", recover: true })
        .pipe(Effect.flip);
      expect(missing.createOutcome).toBe("unresolved");
      const ref = { ...scope, number: 8 };
      yield* transport.updateBody({ ...ref, body: "edited" });
      yield* transport.setState({ ...ref, state: "closed" });
      yield* transport.setState({ ...ref, state: "open" });
      yield* transport.setMilestone({ ...ref, milestoneNumber: null });
      yield* transport.setLabels(ref, ["bug"], ["old"]);
      expect(fixture.calls.slice(-5).map((call) => [call.method, call.body])).toEqual([
        ["PUT", { description: "edited" }],
        ["PUT", { state_event: "close" }],
        ["PUT", { state_event: "reopen" }],
        ["PUT", { milestone_id: 0 }],
        ["PUT", { add_labels: "bug", remove_labels: "old" }],
      ]);
      yield* transport.setMilestone({ ...ref, milestoneNumber: 3 });
      expect(fixture.calls.at(-1)?.body).toEqual({ milestone_id: 39 });
      expect(created.milestoneNumber).toBe(3);
      yield* transport.ensureLabels(scope, [{ name: "external", color: "ff0000" }]);
      expect(fixture.calls.at(-1)?.body).toEqual({ name: "external", color: "#ff0000" });
      expect(
        yield* transport.postIssue(scope, { title: "post", body: "text", labels: ["bug"] }),
      ).toMatchObject({ number: 8, id: 108 });
      expect(yield* transport.postComment(ref, "hello")).toMatchObject({
        id: 51,
        html_url: `${issue(8).web_url}#note_51`,
      });
    }),
);
it.effect(
  "closes GitLab-resolved references only after merge, skipping already closed issues",
  () =>
    Effect.gen(function* () {
      let merged = false;
      const fixture = setup((path, method) =>
        method === "PUT" && path.endsWith("/issues/6")
          ? new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/tmp",
              cause: "refused",
            })
          : path.endsWith("/merge_requests/3")
            ? { ...mr, state: merged ? "merged" : "opened" }
            : path.includes("/closes_issues?")
              ? [issue(6), issue(7), issue(8, { state: "closed" })]
              : path === "projects/12"
                ? project
                : path.endsWith("/issues/8")
                  ? issue(8, { state: "closed" })
                  : path.endsWith("/issues/6")
                    ? issue(6)
                    : path.endsWith("/notes")
                      ? note
                      : issue(7),
      );
      const transport = yield* fixture.make;
      const ref = { ...scope, number: 3 };
      yield* transport.closeIssuesFixedBy!(ref);
      expect(fixture.calls).toHaveLength(1);
      merged = true;
      yield* transport.closeIssuesFixedBy!(ref);
      expect(fixture.calls.filter((call) => call.method === "PUT")).toEqual([
        { path: `${base}/issues/6`, method: "PUT", body: { state_event: "close" } },
        { path: `${base}/issues/7`, method: "PUT", body: { state_event: "close" } },
      ]);
      expect(yield* transport.pullRequest!(ref)).toMatchObject({
        state: "merged",
        baseBranch: "main",
        headBranch: "fix",
        headSha: "abc",
      });
    }),
);

it.effect("claims self-managed hosts from glab even when another login fails", () =>
  Effect.gen(function* () {
    const layer = Layer.mock(GitLabCli.GitLabCli)({
      execute: (input) => {
        expect(input.args).toEqual(["auth", "status", "--all"]);
        expect(input.allowNonZeroExit).toBe(true);
        return Effect.succeed({
          stdout: `gitlab.com\n  x API call failed: 401 Unauthorized\n${host}\n  ✓ Logged in to ${host} as alice\n`,
          stderr: "",
          exitCode: ChildProcessSpawner.ExitCode(1),
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    const hosts = yield* GitLab.discover({
      safeRepository: (_, value) => value,
      resolveScope: (_, input) => Effect.succeed({ ...scope, ...input }),
    }).pipe(Effect.provide(layer));
    expect([...hosts.keys()]).toEqual(["gitlab.com", host]);
    expect(hosts.get(host)?.capabilities).toMatchObject({
      subIssues: true,
      blockers: false,
      milestones: true,
      labels: true,
      liveChanges: false,
      closesFromMergedChangeRequests: true,
    });
  }),
);

it.effect("retains a create receipt before rejecting a malformed response, without retrying", () =>
  Effect.gen(function* () {
    const fixture = setup((path) =>
      path === base ? project : { id: 108, iid: 8, title: "created", web_url: issue(8).web_url },
    );
    const transport = yield* fixture.make;
    const receipts: number[] = [];
    const error = yield* transport
      .createIssue({
        ...scope,
        title: "created",
        body: "",
        milestoneNumber: null,
        writeKey: "receipt",
        recover: false,
        onCreated: (ref) =>
          Effect.sync(() => {
            receipts.push(ref.number);
          }),
      })
      .pipe(Effect.flip);
    expect(receipts).toEqual([8]);
    expect(error).toMatchObject({ code: "invalid-response", createOutcome: "uncertain" });
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(fixture.calls.find((call) => call.method === "POST")?.body).not.toHaveProperty(
      "milestone_id",
    );
  }),
);
