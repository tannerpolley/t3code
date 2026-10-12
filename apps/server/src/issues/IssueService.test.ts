import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueReadError } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";

import * as IssueService from "./IssueService.ts";

const HOST = "github.enterprise.test";
const REPOSITORY = "acme/web";
const ACCOUNT_ID = "account-1";
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
interface MockResponse {
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}
/** One request the service sent, as GitHub received it. */
interface ApiCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

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
): MockResponse {
  return { body: JSON.stringify(body), headers, status };
}

/**
 * The real GitHub transport over a scripted HTTP client, so GitHub's answers are classified as
 * they are in production.
 */
function makeHarness(input: {
  readonly responses: ReadonlyArray<MockResponse>;
  readonly accountId?: string;
  readonly verificationError?: GitHubPullRequestApi.GitHubPullRequestApiError;
}) {
  const responses = [...input.responses];
  const calls: Array<ApiCall> = [];
  const rateLimitRecords: Array<unknown> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls.push({
        method: request.method,
        url: request.url,
        body:
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined,
      });
      const response = responses.shift();
      return response === undefined
        ? Effect.die("unexpected GitHub API call")
        : Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(response.body, {
                status: response.status ?? 200,
                headers: response.headers ?? {},
              }),
            ),
          );
    }),
  );
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("token"),
          source: "gh" as const,
          fingerprint: `${host}:token`,
        }),
      invalidate: () => Effect.void,
    }),
  );
  const rateLimits = Layer.mock(SourceControlRateLimit.SourceControlRateLimit)({
    check: () => Effect.succeed(0),
    recordRateLimit: (record) =>
      Effect.sync(() => {
        rateLimitRecords.push(record);
      }),
    recordSuccess: () => Effect.void,
  });
  const api = GitHubApi.layer.pipe(
    Layer.provide(Layer.mergeAll(http, credentials, rateLimits)),
    Layer.provide(GitHubQuota.layer),
  );
  const verifier =
    input.verificationError === undefined
      ? Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          withVerifiedCredential: (_request, use) =>
            use({
              accountId: input.accountId ?? ACCOUNT_ID,
              viewer: "octocat",
              credentialFingerprint: "credential-fingerprint",
            }),
        })
      : Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          withVerifiedCredential: () => Effect.fail(input.verificationError!),
        });
  const layer = Layer.mergeAll(api, verifier);
  return { layer, calls, rateLimitRecords };
}

function service(harness: ReturnType<typeof makeHarness>) {
  return IssueService.make().pipe(Effect.provide(harness.layer));
}

const listInput = {
  host: HOST,
  repository: REPOSITORY,
};

it.effect("paginates only the selected milestone during repository reconciliation", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(1)], {
          link: `<https://${HOST}/repos/${REPOSITORY}/issues?page=2>; rel="next"`,
        }),
        httpResponse([rawIssue(2)]),
      ],
    });
    const result = yield* (yield* service(harness)).milestoneIssues({
      ...listInput,
      milestoneNumber: 7,
    });
    assert.deepEqual(
      result.issues.map((issue) => issue.number),
      [1, 2],
    );
    assert.isTrue(result.complete);
    assert.isTrue(harness.calls.every((call) => call.url.includes("milestone=7")));
  }),
);

it.effect(
  "reads native hierarchy and closed blockers, and rejects partial GraphQL permission errors",
  () =>
    Effect.gen(function* () {
      const node = (number: number, state = "OPEN") => ({
        id: `node:${number}`,
        databaseId: number,
        number,
        title: `Issue ${number}`,
        url: `https://${HOST}/${REPOSITORY}/issues/${number}`,
        state,
        repository: { databaseId: 123, nameWithOwner: REPOSITORY },
      });
      const connection = (nodes: unknown[], totalCount = nodes.length) => ({
        nodes,
        totalCount,
        pageInfo: { hasNextPage: false, endCursor: null },
      });
      const payload = {
        data: {
          repository: {
            issue: {
              ...node(2),
              milestone: { number: 1 },
              parent: node(1),
              subIssues: connection([node(3)]),
              blockedBy: connection([node(4, "CLOSED")]),
            },
          },
        },
      };
      const harness = makeHarness({ responses: [httpResponse(payload)] });
      const read = yield* (yield* service(harness)).workRead({ ...listInput, number: 2 });
      assert.equal(read.parent?.number, 1);
      assert.equal(read.subIssues[0]?.number, 3);
      assert.equal(read.blockedBy[0]?.state, "closed");
      assert.isTrue(read.parentComplete && read.blockersComplete && read.subIssuesComplete);
      const partial = makeHarness({
        responses: [httpResponse({ ...payload, errors: [{ message: "Forbidden" }] })],
      });
      assert.equal(
        (yield* (yield* service(partial)).workRead({ ...listInput, number: 2 }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      const missingNodes = makeHarness({
        responses: Array.from({ length: 10 }, () =>
          httpResponse({
            data: {
              repository: {
                issue: {
                  ...payload.data.repository.issue,
                  blockedBy: connection([], 1),
                },
              },
            },
          }),
        ),
      });
      assert.isFalse(
        (yield* (yield* service(missingNodes)).workRead({ ...listInput, number: 2 }))
          .blockersComplete,
      );
    }),
);

it.effect("resolves a repository identity without requiring an issue", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [httpResponse({ id: 123, full_name: REPOSITORY })],
    });
    const result = yield* (yield* service(harness)).repositoryIdentity(listInput);
    assert.deepEqual(result, { host: HOST, repository: REPOSITORY, repositoryId: "123" });
    assert.equal(harness.calls.length, 1);
    assert.include(harness.calls[0]!.url, "repos/acme/web");
  }),
);

it.effect("resolves the stable GitHub repository and issue identities", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse({ id: 123, full_name: REPOSITORY }),
        httpResponse({
          id: 456,
          node_id: "I_kwDOIssue456",
          number: 7,
          title: "Stable identity",
          html_url: `https://${HOST}/${REPOSITORY}/issues/7`,
        }),
      ],
    });
    const issues = yield* service(harness);
    const issue = yield* issues.resolveLinkedIssue({ ...listInput, number: 7 });

    assert.deepEqual(issue, {
      host: HOST,
      repository: REPOSITORY,
      repositoryId: "123",
      id: "456",
      nodeId: "I_kwDOIssue456",
      number: 7,
      url: `https://${HOST}/${REPOSITORY}/issues/7`,
      title: "Stable identity",
    });
    assert.include(harness.calls[0]!.url, "repos/acme/web");
    assert.include(harness.calls[1]!.url, "repos/acme/web/issues/7");
  }),
);

it.effect("reconciles an uncertain closeout create by marker before retrying it", () =>
  Effect.gen(function* () {
    const marker = "<!-- t3-issue-closeout:github.com:123:456:thread:child:run:1 -->";
    const harness = makeHarness({
      responses: [
        httpResponse([]),
        httpResponse({ message: "ambiguous write" }, {}, 500),
        httpResponse([{ id: 789, body: `Final result\n\n${marker}` }]),
      ],
    });
    const issues = yield* service(harness);
    const input = {
      issue: {
        host: HOST,
        repository: REPOSITORY,
        repositoryId: "123",
        id: "456",
        nodeId: "I_kwDOIssue456",
        number: 7,
        url: `https://${HOST}/${REPOSITORY}/issues/7`,
        title: "Stable identity",
      },
      operation: "closeout_create" as const,
      marker,
      body: "Final result",
    };
    const first = yield* Effect.result(issues.writeManagedComment(input));
    assert.isTrue(Result.isFailure(first));
    const retry = yield* issues.writeManagedComment(input);

    assert.deepEqual(retry, { commentId: "789" });
    assert.equal(harness.calls.length, 3);
    assert.equal(harness.calls[1]!.method, "POST");
    assert.notEqual(harness.calls[2]!.method, "POST");
  }),
);

it.effect(
  "creates issues with exact payloads and recovers a lost create response without duplicating",
  () =>
    Effect.gen(function* () {
      const repositoryIdentity = { id: 123, node_id: "R_123", full_name: REPOSITORY };
      const marker = "<!-- t3-issue-change:proposal:0 -->";
      const created = {
        ...rawIssue(7),
        id: 456,
        node_id: "I_456",
        html_url: `https://${HOST}/${REPOSITORY}/issues/7`,
        body: `Exact body\n\n${marker}`,
      };
      const harness = makeHarness({
        responses: [
          httpResponse(repositoryIdentity),
          httpResponse({ message: "response lost" }, {}, 500),
          httpResponse(repositoryIdentity),
          httpResponse([created]),
        ],
      });
      const issues = yield* service(harness);
      const input = {
        ...listInput,
        title: "Exact title",
        body: "Exact body",
        milestoneNumber: 2,
        writeKey: "proposal:0",
      };
      assert.isTrue(
        Result.isFailure(yield* Effect.result(issues.createIssue({ ...input, recover: false }))),
      );
      const recovered = yield* issues.createIssue(input);
      assert.equal(recovered.issue.id, "456");
      assert.equal(harness.calls.filter((call) => call.method === "POST").length, 1);
      const payload = yield* decodeJson(harness.calls[1]!.body!);
      assert.deepEqual(payload, {
        title: "Exact title",
        body: `Exact body\n\n${marker}`,
        milestone: 2,
      });
    }),
);

it.effect(
  "writes body, milestone, state and native sub-issue relations through verified GitHub APIs",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({ responses: Array.from({ length: 6 }, () => httpResponse({})) });
      const issues = yield* service(harness);
      const ref = { ...listInput, number: 7 };
      const parent = {
        ...ref,
        repositoryId: "123",
        id: "456",
        nodeId: "I_456",
        url: `https://${HOST}/${REPOSITORY}/issues/7`,
        title: "Parent",
      };
      const child = { ...parent, number: 8, id: "789" };
      yield* issues.updateBody({ ...ref, body: "Exact replacement\n" });
      yield* issues.setMilestone({ ...ref, milestoneNumber: null });
      yield* issues.setState({ ...ref, state: "closed" });
      yield* issues.setState({ ...ref, state: "open" });
      yield* issues.setSubIssue({ parent, child, action: "add" });
      yield* issues.setSubIssue({ parent, child, action: "remove" });
      const payloads = yield* Effect.forEach(harness.calls, (call) => decodeJson(call.body!));
      assert.deepEqual(payloads, [
        { body: "Exact replacement\n" },
        { milestone: null },
        { state: "closed" },
        { state: "open" },
        { sub_issue_id: 789 },
        { sub_issue_id: 789 },
      ]);
      assert.equal(harness.calls[4]!.method, "POST");
      assert.isTrue(harness.calls[4]!.url.endsWith("/repos/acme/web/issues/7/sub_issues"));
      assert.equal(harness.calls[5]!.method, "DELETE");
      assert.isTrue(harness.calls[5]!.url.endsWith("/repos/acme/web/issues/7/sub_issue"));
    }),
);

it.effect("issue writes surface permission failures and respect the shared rate limit", () =>
  Effect.gen(function* () {
    const denied = makeHarness({ responses: [httpResponse({ message: "Forbidden" }, {}, 403)] });
    const deniedResult = yield* Effect.result(
      (yield* service(denied)).updateBody({ ...listInput, number: 7, body: "New" }),
    );
    assert.isTrue(Result.isFailure(deniedResult));
    if (Result.isFailure(deniedResult))
      assert.include(deniedResult.failure.message, "Issues write permission");
    const limited = makeHarness({
      responses: [
        httpResponse(
          { message: "rate limit" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
          403,
        ),
      ],
    });
    const limitedResult = yield* Effect.result(
      (yield* service(limited)).setState({ ...listInput, number: 7, state: "closed" }),
    );
    assert.isTrue(Result.isFailure(limitedResult));
    if (Result.isFailure(limitedResult)) {
      assert.equal(limitedResult.failure.code, "rate-limited");
      assert.isDefined(limitedResult.failure.retryAt);
    }
    assert.equal(limited.rateLimitRecords.length, 1);
  }),
);

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
    assert.include(harness.calls[2]!.url, "repos/acme/web/issues");
    assert.include(harness.calls[2]!.url, "page=2");
    assert.notInclude(harness.calls[2]!.url, "milestones");

    const third = yield* issues.list({ ...listInput, cursor: second.nextCursor! });
    assert.deepEqual(
      third.issues.map((issue) => issue.number),
      [8],
    );
    assert.isTrue(third.issuesComplete);
    assert.isTrue(third.milestonesComplete);
    assert.isNull(third.nextCursor);
    assert.equal(harness.calls.length, 4);
    assert.include(harness.calls[3]!.url, "page=3");
    assert.notInclude(harness.calls[3]!.url, "milestones");

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
    assert.notInclude(harness.calls[2]!.url, "/issues?");
    assert.include(harness.calls[2]!.url, "/milestones?");
    assert.include(harness.calls[2]!.url, "page=2");
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
    assert.include(harness.calls[0]!.url, "/issues?state=all");
    assert.include(harness.calls[1]!.url, "/milestones?state=all");

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
    assert.include(harness.calls[0]!.url, "user/repos?affiliation=owner,organization_member");
    assert.include(harness.calls[1]!.url, "page=2");
  }),
);

it.effect("maps credential failures without exposing credential details", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [],
      verificationError: new GitHubCredentials.GitHubCliFailedError({
        host: HOST,
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
        httpResponse({ message: "secondary rate limit" }, { "Retry-After": "10" }, 403),
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
      responses: [{ body: '{"token":"secret-token"' }],
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
          ),
        ),
      ],
    });
    const issues = yield* service(harness);
    const detail = yield* issues.detail({ ...listInput, number: 7 });

    assert.equal(harness.calls.length, 1);
    assert.include(harness.calls[0]!.url, "graphql");
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

it.effect("rereads an issue without its links when GitHub refuses a cross-reference", () =>
  Effect.gen(function* () {
    // JSON leaves the undefined link fields out, as the narrower query does.
    const issue = graphQlIssue({
      closedByPullRequestsReferences: undefined,
      timelineItems: undefined,
    });
    const harness = makeHarness({
      responses: [
        httpResponse(
          graphQlDetail(graphQlIssue(), [
            { type: "FORBIDDEN", message: "Resource protected by organization SAML" },
          ]),
        ),
        httpResponse(graphQlDetail(issue)),
      ],
    });
    const detail = yield* (yield* service(harness)).detail({ ...listInput, number: 7 });

    assert.equal(detail.issue.number, 7);
    assert.deepEqual(detail.linkedPullRequests, []);
    assert.equal(harness.calls.length, 2);
    assert.notInclude(harness.calls[1]!.body!, "timelineItems");
  }),
);

it.effect("maps a missing issue to inaccessible and a GraphQL rate limit to rate-limited", () =>
  Effect.gen(function* () {
    const missing = makeHarness({
      responses: [
        httpResponse({
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
        }),
      ],
    });
    const missingError = yield* (yield* service(missing))
      .detail({ ...listInput, number: 7 })
      .pipe(Effect.flip);
    assert.equal(missingError.code, "inaccessible");

    const limited = makeHarness({
      responses: [
        httpResponse({ errors: [{ type: "RATE_LIMITED", message: "limit" }] }),
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

it.effect("an uncertain create cannot duplicate an issue after its marker is removed", () =>
  Effect.gen(function* () {
    const identity = { id: 123, node_id: "R_123", full_name: REPOSITORY };
    const existing = {
      ...rawIssue(7),
      id: 456,
      node_id: "I_456",
      html_url: `https://${HOST}/${REPOSITORY}/issues/7`,
      body: "User replaced the issue body",
    };
    const harness = makeHarness({
      responses: [
        httpResponse(identity),
        httpResponse({ message: "response lost" }, {}, 500),
        httpResponse(identity),
        httpResponse([existing]),
      ],
    });
    const issues = yield* service(harness);
    const input = {
      ...listInput,
      title: "Task",
      body: "Task",
      milestoneNumber: null,
      writeKey: "proposal:0",
    };
    const first = yield* issues.createIssue({ ...input, recover: false }).pipe(Effect.flip);
    assert.equal(first.createOutcome, "uncertain");
    const recovery = yield* issues.createIssue({ ...input, recover: true }).pipe(Effect.flip);
    assert.equal(recovery.createOutcome, "unresolved");
    assert.equal(harness.calls.filter((call) => call.method === "POST").length, 1);
  }),
);

it.effect(
  "create failure outcomes distinguish HTTP rejection and preflight denial from uncertain writes",
  () =>
    Effect.gen(function* () {
      const identity = { id: 123, node_id: "R_123", full_name: REPOSITORY };
      const input = {
        ...listInput,
        title: "Task",
        body: "Task",
        milestoneNumber: null,
        writeKey: "rejected:0",
        recover: false,
      };
      for (const status of [401, 403, 404, 422, 429, 500]) {
        const harness = makeHarness({
          responses: [httpResponse(identity), httpResponse({ message: "Denied" }, {}, status)],
        });
        const issues = yield* service(harness);
        const error = yield* issues.createIssue(input).pipe(Effect.flip);
        assert.equal(error.createOutcome, status === 500 ? "uncertain" : "rejected");
      }
      const harness = makeHarness({ responses: [httpResponse({ message: "Denied" }, {}, 403)] });
      const issues = yield* service(harness);
      assert.equal((yield* issues.createIssue(input).pipe(Effect.flip)).createOutcome, "rejected");
      assert.equal(harness.calls.filter((call) => call.method === "POST").length, 0);
    }),
);

it.effect("persists a created issue identity even when mutable response fields are invalid", () =>
  Effect.gen(function* () {
    const identity = { id: 123, node_id: "R_123", full_name: REPOSITORY };
    const created = {
      ...rawIssue(7),
      id: 456,
      node_id: "I_456",
      html_url: `https://${HOST}/${REPOSITORY}/issues/7`,
      body: 42,
    };
    const harness = makeHarness({ responses: [httpResponse(identity), httpResponse(created)] });
    const issues = yield* service(harness);
    const receipts: string[] = [];
    const error = yield* issues
      .createIssue({
        ...listInput,
        title: "Task",
        body: "Task",
        milestoneNumber: null,
        writeKey: "receipt:0",
        recover: false,
        onCreated: (issue) =>
          Effect.sync(() => {
            receipts.push(issue.id);
          }),
      })
      .pipe(Effect.flip);
    assert.equal(error.createOutcome, "uncertain");
    assert.deepEqual(receipts, ["456"]);
  }),
);

it.effect("a denied recovery read does not turn an uncertain create into a rejected create", () =>
  Effect.gen(function* () {
    const identity = { id: 123, node_id: "R_123", full_name: REPOSITORY };
    const harness = makeHarness({
      responses: [
        httpResponse(identity),
        httpResponse({}, {}, 500),
        httpResponse(identity),
        httpResponse({}, {}, 403),
        httpResponse(identity),
        httpResponse([]),
      ],
    });
    const issues = yield* service(harness);
    const input = {
      ...listInput,
      title: "Task",
      body: "Task",
      milestoneNumber: null,
      writeKey: "denied-recovery:0",
    };
    yield* issues.createIssue({ ...input, recover: false }).pipe(Effect.flip);
    assert.equal(
      (yield* issues.createIssue({ ...input, recover: true }).pipe(Effect.flip)).createOutcome,
      "uncertain",
    );
    assert.equal(
      (yield* issues.createIssue({ ...input, recover: true }).pipe(Effect.flip)).createOutcome,
      "unresolved",
    );
    assert.equal(harness.calls.filter((call) => call.method === "POST").length, 1);
  }),
);
