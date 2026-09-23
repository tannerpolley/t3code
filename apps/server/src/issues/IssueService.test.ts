import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { IssueReadError } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as IssueService from "./IssueService.ts";

const HOST = "github.enterprise.test";
const REPOSITORY = "acme/web";
const ACCOUNT_ID = "account-1";
type MockResponse = string | { readonly stdout: string; readonly exitCode: number };

function rawIssue(number: number, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    state_reason: null,
    user: { login: "octocat", avatar_url: null },
    assignees: [],
    labels: [],
    milestone: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    comments: 0,
    body: null,
    ...overrides,
  };
}

function rawPullRequest(number: number) {
  return rawIssue(number, {
    pull_request: { url: `https://${HOST}/${REPOSITORY}/pull/${number}` },
  });
}

function rawMilestone(number: number) {
  return {
    number,
    title: `Milestone ${number}`,
    state: "open",
    due_on: null,
    open_issues: 1,
    closed_issues: 0,
  };
}

function httpResponse(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): string {
  return [
    `HTTP/2 ${status} OK`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    JSON.stringify(body),
  ].join("\r\n");
}

function output(stdout: string, exitCode = 0) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  } satisfies {
    readonly exitCode: ChildProcessSpawner.ExitCode;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  };
}

function makeHarness(input: {
  readonly responses: ReadonlyArray<MockResponse>;
  readonly accountId?: string;
  readonly verificationError?: GitHubPullRequestCli.GitHubPullRequestCliError;
  readonly rateLimitError?: SourceControlRateLimit.SourceControlRateLimitPausedError;
}) {
  const responses = [...input.responses];
  const calls: Array<ReadonlyArray<string>> = [];
  const rateLimitRecords: Array<unknown> = [];
  const github = Layer.mock(GitHubCli.GitHubCli)({
    execute: (request) => {
      calls.push([...request.args]);
      const response = responses.shift();
      return response === undefined
        ? Effect.die("unexpected GitHub API call")
        : Effect.succeed(
            typeof response === "string"
              ? output(response)
              : output(response.stdout, response.exitCode),
          );
    },
  });
  const verifier =
    input.verificationError === undefined
      ? Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          withVerifiedCredential: (_request, use) =>
            use({
              accountId: input.accountId ?? ACCOUNT_ID,
              viewer: "octocat",
              credentialFingerprint: "credential-fingerprint",
            }),
        })
      : Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          withVerifiedCredential: () => Effect.fail(input.verificationError!),
        });
  const rateLimits = Layer.mock(SourceControlRateLimit.SourceControlRateLimit)({
    check: () =>
      input.rateLimitError === undefined ? Effect.succeed(0) : Effect.fail(input.rateLimitError),
    recordRateLimit: (record) =>
      Effect.sync(() => {
        rateLimitRecords.push(record);
      }),
    recordSuccess: () => Effect.void,
  });
  const layer = Layer.mergeAll(github, verifier, rateLimits);
  return { layer, calls, rateLimitRecords };
}

function service(harness: ReturnType<typeof makeHarness>) {
  return IssueService.make().pipe(Effect.provide(harness.layer));
}

const listInput = {
  host: HOST,
  repository: REPOSITORY,
};

it.effect("filters mixed and PR-only pages without re-requesting a completed stream", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawPullRequest(99), rawIssue(7)], {
          link: `<https://${HOST}/repositories/123/issues?page=2>; rel="next"`,
        }),
        httpResponse([]),
        httpResponse([rawPullRequest(100)], {
          link: `<https://${HOST}/repositories/123/issues?page=3>; rel="next"`,
        }),
        httpResponse([rawIssue(8)]),
      ],
    });
    const issues = yield* service(harness);
    const first = yield* issues.list(listInput);

    assert.deepEqual(
      first.issues.map((issue) => issue.number),
      [7],
    );
    assert.isFalse(first.issuesComplete);
    assert.isTrue(first.milestonesComplete);
    assert.isNotNull(first.nextCursor);

    const second = yield* issues.list({ ...listInput, cursor: first.nextCursor! });
    assert.deepEqual(second.issues, []);
    assert.isFalse(second.issuesComplete);
    assert.isTrue(second.milestonesComplete);
    assert.isNotNull(second.nextCursor);
    assert.equal(harness.calls.length, 3);
    assert.include(harness.calls[2]!.join(" "), "repos/acme/web/issues");
    assert.include(harness.calls[2]!.join(" "), "page=2");
    assert.notInclude(harness.calls[2]!.join(" "), "milestones");

    const third = yield* issues.list({ ...listInput, cursor: second.nextCursor! });
    assert.deepEqual(
      third.issues.map((issue) => issue.number),
      [8],
    );
    assert.isTrue(third.issuesComplete);
    assert.isTrue(third.milestonesComplete);
    assert.isNull(third.nextCursor);
    assert.equal(harness.calls.length, 4);
    assert.include(harness.calls[3]!.join(" "), "page=3");
    assert.notInclude(harness.calls[3]!.join(" "), "milestones");

    const otherAccount = makeHarness({ responses: [], accountId: "account-2" });
    const otherAccountIssues = yield* service(otherAccount);
    const accountError = yield* otherAccountIssues
      .list({ ...listInput, cursor: first.nextCursor! })
      .pipe(Effect.flip);
    assert.equal(accountError.code, "invalid-cursor");
    assert.deepEqual(otherAccount.calls, []);
  }),
);

it.effect("continues milestones after issues finish and does not request issues again", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7)]),
        httpResponse([rawMilestone(1)], {
          link: `<https://${HOST}/repositories/123/milestones?page=2>; rel="next"`,
        }),
        httpResponse([]),
      ],
    });
    const issues = yield* service(harness);
    const first = yield* issues.list(listInput);

    assert.isTrue(first.issuesComplete);
    assert.isFalse(first.milestonesComplete);
    assert.isNotNull(first.nextCursor);

    const second = yield* issues.list({ ...listInput, cursor: first.nextCursor! });
    assert.deepEqual(second.issues, []);
    assert.deepEqual(second.milestones, []);
    assert.isTrue(second.issuesComplete);
    assert.isTrue(second.milestonesComplete);
    assert.equal(harness.calls.length, 3);
    assert.notInclude(harness.calls[2]!.join(" "), "/issues?");
    assert.include(harness.calls[2]!.join(" "), "/milestones?");
    assert.include(harness.calls[2]!.join(" "), "page=2");
  }),
);

it.effect("rejects a repository that cannot be addressed before calling GitHub", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ responses: [] });
    const issues = yield* service(harness);
    const error = yield* issues
      .list({ host: HOST, repository: "not-a-repository" })
      .pipe(Effect.flip);

    assert.isTrue(Schema.is(IssueReadError)(error));
    assert.equal(error.code, "scope-unavailable");
    assert.deepEqual(harness.calls, []);
  }),
);

it.effect("reads closed issues only when asked and keeps cursors bound to their state", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7), rawIssue(8, { state: "closed" })], {
          link: `<https://${HOST}/repositories/123/issues?page=2>; rel="next"`,
        }),
        httpResponse([]),
      ],
    });
    const issues = yield* service(harness);
    const all = yield* issues.list({ ...listInput, state: "all" });

    assert.deepEqual(
      all.issues.map((issue) => [issue.number, issue.state]),
      [
        [7, "open"],
        [8, "closed"],
      ],
    );
    assert.include(harness.calls[0]!.join(" "), "/issues?state=all");
    assert.include(harness.calls[1]!.join(" "), "/milestones?state=all");

    const error = yield* issues
      .list({ ...listInput, state: "open", cursor: all.nextCursor! })
      .pipe(Effect.flip);
    assert.equal(error.code, "invalid-cursor");
    assert.equal(harness.calls.length, 2);
  }),
);

function rawRepository(
  fullName: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    full_name: fullName,
    owner: { login: fullName.split("/")[0], type: "User" },
    private: false,
    archived: false,
    fork: false,
    has_issues: true,
    open_issues_count: 3,
    pushed_at: "2026-01-03T00:00:00Z",
    permissions: { admin: false },
    ...overrides,
  };
}

it.effect("lists only repositories the viewer owns or administers, across pages", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse(
          [
            rawRepository("octocat/app"),
            rawRepository("OctoCat/Fork", { has_issues: false }),
            rawRepository("octocat/old", { archived: true, fork: true }),
            rawRepository("acme/admin", {
              owner: { login: "acme", type: "Organization" },
              permissions: { admin: true },
            }),
          ],
          { link: `<https://api.github.com/user/repos?page=2>; rel="next"` },
        ),
        httpResponse([
          rawRepository("acme/member", {
            owner: { login: "acme", type: "Organization" },
            permissions: { admin: false },
          }),
          rawRepository("someone/collab", { permissions: { admin: true } }),
          rawRepository("octocat/app"),
        ]),
      ],
    });
    const issues = yield* service(harness);
    const result = yield* issues.repositories();

    assert.deepEqual(
      result.repositories.map((repository) => [
        repository.repository,
        repository.ownerIsOrganization,
        repository.isArchived,
        repository.isFork,
      ]),
      [
        ["octocat/app", false, false, false],
        ["octocat/old", false, true, true],
        ["acme/admin", true, false, false],
      ],
    );
    assert.isTrue(result.complete);
    assert.equal(result.viewer.login, "octocat");
    assert.include(harness.calls[0]!.join(" "), "user/repos?affiliation=owner,organization_member");
    assert.include(harness.calls[1]!.join(" "), "page=2");
  }),
);

it.effect("maps credential failures without exposing credential details", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [],
      verificationError: new GitHubCli.GitHubCliAuthenticationError({
        command: "gh",
        cwd: "/home/test",
        cause: new Error("token=do-not-return-this"),
      }),
    });
    const issues = yield* service(harness);
    const error = yield* issues.list(listInput).pipe(Effect.flip);

    assert.equal(error.code, "unauthenticated");
    assert.notInclude(error.message, "do-not-return-this");
    assert.deepEqual(harness.calls, []);
  }),
);

it.effect("shares a 403 Retry-After pause with the rate-limit service", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        {
          stdout: httpResponse({ message: "secondary rate limit" }, { "Retry-After": "10" }, 403),
          exitCode: 1,
        },
      ],
    });
    const issues = yield* service(harness);
    const error = yield* issues.list(listInput).pipe(Effect.flip);

    assert.equal(error.code, "rate-limited");
    assert.isTrue(error.retryAt !== undefined);
    assert.equal(harness.rateLimitRecords.length, 1);
    assert.equal(harness.calls.length, 1);
  }),
);

it.effect("maps malformed upstream data safely and normalizes null detail bodies", () =>
  Effect.gen(function* () {
    const malformed = makeHarness({
      responses: [{ stdout: '{"token":"secret-token"', exitCode: 1 }],
    });
    const malformedService = yield* service(malformed);
    const malformedError = yield* malformedService.list(listInput).pipe(Effect.flip);
    assert.equal(malformedError.code, "invalid-response");
    assert.notInclude(malformedError.message, "secret-token");

    const detailHarness = makeHarness({
      responses: [httpResponse(graphQlDetail(graphQlIssue({ body: null })))],
    });
    const detailService = yield* service(detailHarness);
    const detail = yield* detailService.detail({
      ...listInput,
      number: 7,
    });
    assert.equal(detail.body, "");
  }),
);

function graphQlPullRequest(
  number: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    url: `https://${HOST}/${REPOSITORY}/pull/${number}`,
    repository: { nameWithOwner: REPOSITORY },
    ...overrides,
  };
}

function graphQlIssue(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: "Issue",
    number: 7,
    title: "Issue 7",
    body: "Body",
    state: "CLOSED",
    stateReason: "NOT_PLANNED",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    author: { login: "octocat", avatarUrl: "https://avatars.test/u/1?v=4" },
    assignees: { nodes: [] },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
    milestone: null,
    comments: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

function graphQlDetail(issue: unknown, errors?: ReadonlyArray<unknown>): unknown {
  return {
    data: { repository: { issueOrPullRequest: issue } },
    ...(errors === undefined ? {} : { errors }),
  };
}

it.effect("reads issue detail, comments, and linked pull requests in one GraphQL request", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse(
          graphQlDetail(
            graphQlIssue({
              comments: {
                totalCount: 150,
                nodes: [
                  {
                    author: null,
                    body: "First kept",
                    createdAt: "2026-01-03T00:00:00Z",
                    url: `https://${HOST}/${REPOSITORY}/issues/7#issuecomment-1`,
                  },
                  null,
                  {
                    author: { login: "hubot", avatarUrl: null },
                    body: "Latest",
                    createdAt: "2026-01-04T00:00:00Z",
                    url: `https://${HOST}/${REPOSITORY}/issues/7#issuecomment-2`,
                  },
                ],
              },
              closedByPullRequestsReferences: {
                nodes: [graphQlPullRequest(11, { state: "MERGED" })],
              },
              timelineItems: {
                nodes: [
                  { source: { __typename: "Issue" } },
                  {
                    source: {
                      __typename: "PullRequest",
                      ...graphQlPullRequest(11, { state: "MERGED" }),
                    },
                  },
                  {
                    source: {
                      __typename: "PullRequest",
                      ...graphQlPullRequest(11, {
                        state: "CLOSED",
                        repository: { nameWithOwner: "Acme/Fork" },
                        url: `https://${HOST}/Acme/Fork/pull/11`,
                      }),
                    },
                  },
                  {
                    source: {
                      __typename: "PullRequest",
                      ...graphQlPullRequest(12, { isDraft: true }),
                    },
                  },
                  {},
                ],
              },
            }),
            // Partial errors, such as an SSO-hidden cross-reference, keep the issue readable.
            [{ type: "FORBIDDEN", message: "Resource protected by organization SAML" }],
          ),
        ),
      ],
    });
    const issues = yield* service(harness);
    const detail = yield* issues.detail({ ...listInput, number: 7 });

    assert.equal(harness.calls.length, 1);
    assert.include(harness.calls[0]!.join(" "), "graphql");
    assert.equal(detail.issue.state, "closed");
    assert.equal(detail.issue.stateReason, "not_planned");
    assert.equal(detail.issue.commentCount, 150);
    assert.equal(detail.issue.author?.avatarUrl, "https://avatars.test/u/1");
    assert.deepEqual(
      detail.comments.map((comment) => [comment.author?.login ?? null, comment.body]),
      [
        [null, "First kept"],
        ["hubot", "Latest"],
      ],
    );
    assert.deepEqual(
      detail.linkedPullRequests.map((pr) => [
        pr.repository,
        pr.number,
        pr.state,
        pr.isDraft,
        pr.closesIssue,
      ]),
      [
        [REPOSITORY, 11, "merged", false, true],
        ["Acme/Fork", 11, "closed", false, false],
        [REPOSITORY, 12, "open", true, false],
      ],
    );
  }),
);

it.effect("maps a missing issue to inaccessible and a GraphQL rate limit to rate-limited", () =>
  Effect.gen(function* () {
    const missing = makeHarness({
      responses: [
        {
          stdout: httpResponse({
            data: { repository: null },
            errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
          }),
          exitCode: 1,
        },
      ],
    });
    const missingError = yield* (yield* service(missing))
      .detail({ ...listInput, number: 7 })
      .pipe(Effect.flip);
    assert.equal(missingError.code, "inaccessible");

    const limited = makeHarness({
      responses: [
        {
          stdout: httpResponse({ errors: [{ type: "RATE_LIMITED", message: "limit" }] }),
          exitCode: 1,
        },
      ],
    });
    const limitedError = yield* (yield* service(limited))
      .detail({ ...listInput, number: 7 })
      .pipe(Effect.flip);
    assert.equal(limitedError.code, "rate-limited");
    assert.equal(limited.rateLimitRecords.length, 1);
  }),
);

it.effect("rejects pull request detail responses", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [httpResponse(graphQlDetail({ __typename: "PullRequest" }))],
    });
    const issues = yield* service(harness);
    const error = yield* issues.detail({ ...listInput, number: 7 }).pipe(Effect.flip);

    assert.equal(error.code, "unsupported");
    assert.equal(harness.calls.length, 1);
  }),
);
