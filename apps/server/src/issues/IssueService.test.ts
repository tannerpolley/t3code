import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueReadError } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "./IssueGitHubApi.ts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";

import * as IssueService from "./IssueService.ts";

const HOST = "github.enterprise.test";
const REPOSITORY = "acme/web";
const ACCOUNT_ID = "account-1";
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProjectRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Number, Schema.Null]),
      ),
    }),
  ),
);
interface MockResponse {
  readonly body: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}
/** One request the service sent, as GitHub received it. */
interface ApiCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
  readonly ifNoneMatch: string | undefined;
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
  readonly onRequest?: (call: ApiCall) => Effect.Effect<void>;
  readonly accountId?: string;
  readonly credentialFingerprint?: () => string;
  readonly verificationError?: GitHubPullRequestApi.GitHubPullRequestApiError;
  readonly verificationErrorHost?: string;
}) {
  const responses = [...input.responses];
  const calls: Array<ApiCall> = [];
  const rateLimitRecords: Array<unknown> = [];
  const invalidatedHosts: Array<string> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const call = {
        method: request.method,
        ifNoneMatch: request.headers["if-none-match"],
        url: request.url,
        body:
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined,
      };
      calls.push(call);
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
          ).pipe(Effect.tap(() => input.onRequest?.(call) ?? Effect.void));
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
      invalidate: (host) =>
        Effect.sync(() => {
          invalidatedHosts.push(host);
        }),
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
    Layer.provide(GitHubRest.layer),
    Layer.provide(Layer.mergeAll(http, credentials, rateLimits)),
    Layer.provide(GitHubQuota.layer),
  );
  const verifier = Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
    withVerifiedCredential: (request, use) =>
      input.verificationError !== undefined &&
      (input.verificationErrorHost === undefined || input.verificationErrorHost === request.host)
        ? Effect.fail(input.verificationError)
        : use({
            accountId: input.accountId ?? ACCOUNT_ID,
            viewer: "octocat",
            credentialFingerprint: input.credentialFingerprint?.() ?? "credential-fingerprint",
          }),
  });
  const layer = Layer.mergeAll(api, verifier);
  return { layer, calls, rateLimitRecords, invalidatedHosts };
}

function service(harness: ReturnType<typeof makeHarness>) {
  return IssueService.make().pipe(Effect.provide(harness.layer));
}

const listInput = {
  host: HOST,
  repository: REPOSITORY,
};

it.effect(
  "batches sidebar status reads, preserving accessible nodes and omitting incomplete ones",
  () =>
    Effect.gen(function* () {
      const connection = (nodes: readonly unknown[], hasNextPage = false) => ({
        nodes,
        pageInfo: { hasNextPage },
      });
      const node = (id: string, overrides: Record<string, unknown> = {}) => ({
        __typename: "Issue",
        id,
        number: Number(id.slice(2)) + 1,
        repository: { nameWithOwner: REPOSITORY },
        state: "OPEN",
        stateReason: null,
        blockedBy: connection([]),
        closedByPullRequestsReferences: connection([]),
        ...overrides,
      });
      const nodes: unknown[] = Array.from({ length: 100 }, () => null);
      nodes[0] = node("I_0", { state: "CLOSED", stateReason: "NOT_PLANNED" });
      nodes[2] = node("I_2");
      nodes[3] = { __typename: "PullRequest" };
      nodes[4] = node("I_4", { blockedBy: connection([], true) });
      const harness = makeHarness({
        responses: [
          httpResponse({
            data: { nodes },
            errors: [
              { type: "NOT_FOUND", path: ["nodes", 1] },
              { type: "FORBIDDEN", path: ["nodes", 2, "blockedBy"] },
            ],
          }),
          httpResponse({
            data: {
              nodes: [
                node("I_100", {
                  blockedBy: connection([{ state: "OPEN" }, { state: "CLOSED" }]),
                  closedByPullRequestsReferences: connection([
                    {
                      number: 7,
                      repository: { nameWithOwner: "acme/other" },
                      state: "MERGED",
                      updatedAt: "2026-10-19T00:00:00Z",
                    },
                    {
                      number: 8,
                      repository: { nameWithOwner: REPOSITORY },
                      state: "OPEN",
                      updatedAt: "2026-10-19T01:00:00Z",
                    },
                  ]),
                }),
              ],
            },
          }),
        ],
      });
      const refs = Array.from({ length: 101 }, (_, index) => ({
        host: HOST,
        nodeId: `I_${index}`,
      }));
      const result = yield* (yield* service(harness)).statusBatch({ issues: [...refs, refs[0]!] });
      assert.deepEqual(result, [
        {
          host: HOST,
          nodeId: "I_0",
          repository: REPOSITORY,
          number: 1,
          state: "closed",
          stateReason: "not_planned",
          blockedBy: [],
          pullRequests: [],
        },
        {
          host: HOST,
          nodeId: "I_100",
          repository: REPOSITORY,
          number: 101,
          state: "open",
          stateReason: null,
          blockedBy: [{ state: "open" }, { state: "closed" }],
          pullRequests: [
            {
              host: HOST,
              repository: "acme/other",
              number: 7,
              state: "merged",
              updatedAt: "2026-10-19T00:00:00Z",
            },
            {
              host: HOST,
              repository: REPOSITORY,
              number: 8,
              state: "open",
              updatedAt: "2026-10-19T01:00:00Z",
            },
          ],
        },
      ]);
      const decodeRequest = Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            variables: Schema.Struct({ ids: Schema.Array(Schema.String) }),
          }),
        ),
      );
      const requests = yield* Effect.forEach(harness.calls, (call) => decodeRequest(call.body!));
      assert.deepEqual(
        requests.map((request) => request.variables.ids),
        [refs.slice(0, 100).map((ref) => ref.nodeId), ["I_100"]],
      );
    }),
);

it.effect(
  "keeps successful hosts' issue statuses when another host fails credential verification",
  () =>
    Effect.gen(function* () {
      const failedHost = "unavailable.enterprise.test";
      const harness = makeHarness({
        verificationErrorHost: failedHost,
        verificationError: new GitHubCredentials.GitHubCliFailedError({
          host: failedHost,
          cause: new Error("credential unavailable"),
        }),
        responses: [
          httpResponse({
            data: {
              nodes: [
                {
                  __typename: "Issue",
                  id: "I_ok",
                  number: 13,
                  repository: { nameWithOwner: REPOSITORY },
                  state: "OPEN",
                  stateReason: null,
                  blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                  closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
                },
              ],
            },
          }),
        ],
      });
      const result = yield* (yield* service(harness)).statusBatch({
        issues: [
          { host: failedHost, nodeId: "I_failed" },
          { host: HOST, nodeId: "I_ok" },
        ],
      });
      assert.deepEqual(result, [
        {
          host: HOST,
          repository: REPOSITORY,
          number: 13,
          nodeId: "I_ok",
          state: "open",
          stateReason: null,
          blockedBy: [],
          pullRequests: [],
        },
      ]);
      assert.equal(harness.calls.length, 1);
      assert.equal(new URL(harness.calls[0]!.url).host, HOST);
    }),
);

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

it.effect("treats a milestone as missing only when GitHub cannot find it", () =>
  Effect.gen(function* () {
    // [issue list status, milestone lookup status]; a 422 with a found milestone is the spam guard.
    for (const [listStatus, lookupStatus] of [
      [422, 404],
      [422, 200],
      [403, undefined],
      [500, undefined],
    ] as const) {
      const harness = makeHarness({
        responses: [
          httpResponse({}, {}, listStatus),
          ...(lookupStatus === undefined ? [] : [httpResponse({}, {}, lookupStatus)]),
        ],
      });
      const result = yield* (yield* service(harness))
        .milestoneIssues({ ...listInput, milestoneNumber: 23 })
        .pipe(Effect.result);
      if (lookupStatus === 404) {
        assert.deepEqual(Result.getOrThrow(result), { issues: [], complete: true, missing: true });
        assert.include(harness.calls[1]!.url, "/milestones/23");
      } else {
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.equal(result.failure.code, listStatus === 403 ? "inaccessible" : "upstream");
      }
      assert.include(harness.calls[0]!.url, "state=all");
    }
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

it.effect(
  "revalidates issue and milestone pages, retaining their decoded bodies and pagination on 304",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        responses: [
          httpResponse([rawIssue(7)], {
            etag: '"issues-1"',
            link: `<https://${HOST}/issues?page=2>; rel="next"`,
          }),
          httpResponse([rawMilestone(1)], {
            etag: '"milestones-1"',
            link: `<https://${HOST}/milestones?page=2>; rel="next"`,
          }),
          httpResponse({ data: {} }),
          { status: 304, body: null },
          { status: 304, body: null },
          httpResponse({ data: {} }),
        ],
      });
      const issues = yield* service(harness);
      const first = yield* issues.list(listInput);
      const warm = yield* issues.list(listInput);
      assert.deepEqual(warm.issues, first.issues);
      assert.deepEqual(warm.milestones, first.milestones);
      assert.equal(warm.nextCursor, first.nextCursor);
      assert.isFalse(warm.issuesComplete);
      assert.isFalse(warm.milestonesComplete);
      assert.equal(harness.calls[3]!.ifNoneMatch, '"issues-1"');
      assert.equal(harness.calls[4]!.ifNoneMatch, '"milestones-1"');
    }),
);

it.effect("a changed 200 replaces each cached page and its ETag and pagination", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7)], {
          etag: '"issues-1"',
          link: `<https://${HOST}/issues?page=2>; rel="next"`,
        }),
        httpResponse([rawMilestone(1)], { etag: '"milestones-1"' }),
        httpResponse({ data: {} }),
        httpResponse([rawIssue(8)], { etag: '"issues-2"' }),
        httpResponse([rawMilestone(2)], { etag: '"milestones-2"' }),
        httpResponse({ data: {} }),
        { status: 304, body: null },
        { status: 304, body: null },
        httpResponse({ data: {} }),
      ],
    });
    const issues = yield* service(harness);
    yield* issues.list(listInput);
    const changed = yield* issues.list(listInput);
    const warm = yield* issues.list(listInput);
    assert.deepEqual(
      changed.issues.map((issue) => issue.number),
      [8],
    );
    assert.deepEqual(
      changed.milestones.map((milestone) => milestone.number),
      [2],
    );
    assert.isNull(changed.nextCursor);
    assert.deepEqual(warm.issues, changed.issues);
    assert.deepEqual(warm.milestones, changed.milestones);
    assert.isNull(warm.nextCursor);
    assert.equal(harness.calls[6]!.ifNoneMatch, '"issues-2"');
    assert.equal(harness.calls[7]!.ifNoneMatch, '"milestones-2"');
  }),
);

it.effect("checks a later issue page with its own ETag after page one returns 304", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7)], {
          etag: '"page-1"',
          link: `<https://${HOST}/issues?page=2>; rel="next"`,
        }),
        httpResponse([], { etag: '"milestones"' }),
        httpResponse({ data: {} }),
        httpResponse([rawIssue(8)], { etag: '"page-2"' }),
        httpResponse({ data: {} }),
        { status: 304, body: null },
        { status: 304, body: null },
        httpResponse({ data: {} }),
        httpResponse([rawIssue(9)], { etag: '"page-2-changed"' }),
        httpResponse({ data: {} }),
      ],
    });
    const issues = yield* service(harness);
    const first = yield* issues.list(listInput);
    yield* issues.list({ ...listInput, cursor: first.nextCursor! });
    const warm = yield* issues.list(listInput);
    const later = yield* issues.list({ ...listInput, cursor: warm.nextCursor! });
    assert.deepEqual(
      later.issues.map((issue) => issue.number),
      [9],
    );
    assert.equal(harness.calls[5]!.ifNoneMatch, '"page-1"');
    assert.equal(harness.calls[8]!.ifNoneMatch, '"page-2"');
    assert.include(harness.calls[8]!.url, "page=2");
  }),
);

it.effect("evicts old issue pages at the per-repository bound", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        ...Array.from({ length: 33 }, (_, index) =>
          httpResponse([rawIssue(index + 1)], { etag: `"page-${index}"` }),
        ),
        { status: 304, body: null },
        httpResponse([rawIssue(34)], { etag: '"refreshed"' }),
      ],
    });
    const issues = yield* service(harness);
    for (let milestoneNumber = 1; milestoneNumber <= 33; milestoneNumber++)
      yield* issues.milestoneIssues({ ...listInput, milestoneNumber });
    const retained = yield* issues.milestoneIssues({ ...listInput, milestoneNumber: 33 });
    assert.deepEqual(
      retained.issues.map((issue) => issue.number),
      [33],
    );
    assert.equal(harness.calls[33]!.ifNoneMatch, '"page-32"');
    const refreshed = yield* issues.milestoneIssues({ ...listInput, milestoneNumber: 1 });
    assert.isUndefined(harness.calls[34]!.ifNoneMatch);
    assert.deepEqual(
      refreshed.issues.map((issue) => issue.number),
      [34],
    );
  }),
);

it.effect("drops cached pages after the repository stops being listed for five minutes", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7)], { etag: '"page-1"' }),
        { status: 304, body: null },
        httpResponse([rawIssue(8)], { etag: '"page-2"' }),
      ],
    });
    const issues = yield* service(harness);
    const input = { ...listInput, milestoneNumber: 1 };
    yield* issues.milestoneIssues(input);
    yield* TestClock.adjust("4 minutes");
    assert.deepEqual(
      (yield* issues.milestoneIssues(input)).issues.map((issue) => issue.number),
      [7],
    );
    yield* TestClock.adjust("5 minutes");
    assert.deepEqual(
      (yield* issues.milestoneIssues(input)).issues.map((issue) => issue.number),
      [8],
    );
    assert.equal(harness.calls[1]!.ifNoneMatch, '"page-1"');
    assert.isUndefined(harness.calls[2]!.ifNoneMatch);
  }),
);

it.effect("keeps list validators separate across hosts, repositories, states and credentials", () =>
  Effect.gen(function* () {
    const inputs = [
      listInput,
      { ...listInput, state: "all" as const },
      { ...listInput, repository: "acme/other" },
      { ...listInput, host: "other.enterprise.test" },
    ];
    let credential = "first";
    const harness = makeHarness({
      credentialFingerprint: () => credential,
      responses: [
        ...inputs.flatMap((_, index) => [
          httpResponse([rawIssue(index + 1)], { etag: `"issues-${index}"` }),
          httpResponse([], { etag: `"milestones-${index}"` }),
          httpResponse({ data: {} }),
        ]),
        ...inputs.flatMap(() => [
          { status: 304, body: null },
          { status: 304, body: null },
          httpResponse({ data: {} }),
        ]),
        httpResponse([rawIssue(99)], { etag: '"other-credential"' }),
        httpResponse([]),
        httpResponse({ data: {} }),
      ],
    });
    const issues = yield* service(harness);
    for (const input of inputs) yield* issues.list(input);
    for (const [index, input] of inputs.entries()) {
      const result = yield* issues.list(input);
      assert.deepEqual(
        result.issues.map((issue) => issue.number),
        [index + 1],
      );
      assert.isUndefined(harness.calls[index * 3]!.ifNoneMatch);
      assert.equal(harness.calls[12 + index * 3]!.ifNoneMatch, `"issues-${index}"`);
      assert.equal(harness.calls[13 + index * 3]!.ifNoneMatch, `"milestones-${index}"`);
    }
    credential = "second";
    assert.deepEqual(
      (yield* issues.list(listInput)).issues.map((issue) => issue.number),
      [99],
    );
    assert.isUndefined(harness.calls[24]!.ifNoneMatch);
    assert.isUndefined(harness.calls[25]!.ifNoneMatch);
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
        httpResponse({ data: {} }),
        httpResponse([rawPullRequest(100)], {
          link: `<https://${HOST}/repositories/123/issues?page=3>; rel="next"`,
        }),
        httpResponse([rawIssue(8)]),
        httpResponse({ data: {} }),
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
    assert.equal(harness.calls.length, 4);
    assert.include(harness.calls[3]!.url, "repos/acme/web/issues");
    assert.include(harness.calls[3]!.url, "page=2");
    assert.notInclude(harness.calls[3]!.url, "milestones");

    const third = yield* issues.list({ ...listInput, cursor: second.nextCursor! });
    assert.deepEqual(
      third.issues.map((issue) => issue.number),
      [8],
    );
    assert.isTrue(third.issuesComplete);
    assert.isTrue(third.milestonesComplete);
    assert.isNull(third.nextCursor);
    assert.equal(harness.calls.length, 6);
    assert.include(harness.calls[4]!.url, "page=3");
    assert.notInclude(harness.calls[4]!.url, "milestones");

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
        httpResponse({ data: {} }),
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
    assert.equal(harness.calls.length, 4);
    assert.notInclude(harness.calls[3]!.url, "/issues?");
    assert.include(harness.calls[3]!.url, "/milestones?");
    assert.include(harness.calls[3]!.url, "page=2");
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
        httpResponse(
          [
            rawIssue(7, { sub_issues_summary: { total: 5, completed: 2, percent_completed: 40 } }),
            rawIssue(8, {
              state: "closed",
              sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
            }),
          ],
          {
            link: `<https://${HOST}/repositories/123/issues?page=2>; rel="next"`,
          },
        ),
        httpResponse([]),
        httpResponse({ data: {} }),
      ],
    });
    const issues = yield* service(harness);
    const all = yield* issues.list({ ...listInput, state: "all" });
    // Sub-issue progress rides on the list page; an issue without sub-issues carries none.
    assert.deepEqual(all.issues[0]!.subIssues, { total: 5, completed: 2 });
    assert.notProperty(all.issues[1]!, "subIssues");

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
    assert.equal(harness.calls.length, 3);
  }),
);

function projectConnection(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function projectField(name: string, optionId = "first") {
  return {
    __typename: "ProjectV2ItemFieldSingleSelectValue",
    name,
    optionId,
    field: {
      options: [
        { id: "first", name: "High" },
        { id: "second", name: "Urgent" },
      ],
    },
  };
}

function projectItem(id: string, title: string, status: unknown = null, priority: unknown = null) {
  return { project: { id, title }, status, priority };
}

it.effect("batches named Project fields, skips archived items and retains option order", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7), rawIssue(8)]),
        httpResponse([]),
        httpResponse({
          data: {
            p0: {
              issue: {
                projectItems: projectConnection([
                  null,
                  { ...projectItem("hidden", "Hidden"), project: null },
                  projectItem(
                    "one",
                    "Planning",
                    projectField("In Progress"),
                    projectField("Urgent", "second"),
                  ),
                  projectItem(
                    "two",
                    "Delivery",
                    { __typename: "ProjectV2ItemFieldTextValue" },
                    projectField("High"),
                  ),
                ]),
              },
            },
            p1: { issue: { projectItems: projectConnection([]) } },
          },
        }),
      ],
    });
    const result = yield* (yield* service(harness)).list(listInput);
    assert.deepEqual(result.issues[0]?.projects, [
      {
        id: "one",
        title: "Planning",
        status: "In Progress",
        priority: { name: "Urgent", rank: 1 },
      },
      { id: "two", title: "Delivery", status: null, priority: { name: "High", rank: 0 } },
    ]);
    assert.deepEqual(result.issues[1]?.projects, []);
    assert.equal(harness.calls.length, 3);
    const request = yield* decodeProjectRequest(harness.calls[2]!.body!);
    assert.deepEqual([request.variables.number0, request.variables.number1], [7, 8]);
    assert.include(request.query, "ProjectV2ItemFieldSingleSelectValue");
    assert.include(request.query, 'status: fieldValueByName(name: "Status")');
    assert.include(request.query, 'priority: fieldValueByName(name: "Priority")');
    assert.include(request.query, "options { id name }");
    assert.include(request.query, "includeArchived: false");
    assert.notInclude(request.query, "fieldValues(");
  }),
);

it.effect("paginates Project items without field-value follow-up reads", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7)]),
        httpResponse([]),
        httpResponse({
          data: {
            p0: {
              issue: {
                projectItems: projectConnection(
                  [
                    projectItem(
                      "one",
                      "Planning",
                      projectField("Todo"),
                      projectField("Custom", "unknown"),
                    ),
                  ],
                  "projects-1",
                ),
              },
            },
          },
        }),
        httpResponse({
          data: {
            p0: { issue: { projectItems: projectConnection([projectItem("two", "Delivery")]) } },
          },
        }),
      ],
    });
    const result = yield* (yield* service(harness)).list(listInput);
    assert.deepEqual(result.issues[0]?.projects, [
      { id: "one", title: "Planning", status: "Todo", priority: { name: "Custom", rank: null } },
      { id: "two", title: "Delivery", status: null, priority: null },
    ]);
    assert.equal(harness.calls.length, 4);
    const request = yield* decodeProjectRequest(harness.calls[3]!.body!);
    assert.equal(request.variables.cursor0, "projects-1");
    assert.notInclude(request.query, "node(id:");
  }),
);

it.effect("keeps other issues' Project chips when an aliased issue fails", () =>
  Effect.gen(function* () {
    for (const type of ["NOT_FOUND", "FORBIDDEN"]) {
      const harness = makeHarness({
        responses: [
          httpResponse([rawIssue(7), rawIssue(8)]),
          httpResponse([]),
          httpResponse({
            data: {
              p0:
                type === "NOT_FOUND"
                  ? { issue: null }
                  : {
                      issue: {
                        projectItems: projectConnection([
                          projectItem("partial", "Partial", projectField("Todo")),
                        ]),
                      },
                    },
              p1: {
                issue: {
                  projectItems: projectConnection([
                    projectItem(
                      "one",
                      "Planning",
                      projectField("In Progress"),
                      projectField("High"),
                    ),
                  ]),
                },
              },
            },
            errors: [{ type, message: "Issue or Project unavailable", path: ["p0", "issue"] }],
          }),
        ],
      });
      const result = yield* (yield* service(harness)).list(listInput);
      assert.deepEqual(result.issues[0]?.projects, []);
      assert.deepEqual(result.issues[1]?.projects, [
        {
          id: "one",
          title: "Planning",
          status: "In Progress",
          priority: { name: "High", rank: 0 },
        },
      ]);
      assert.isTrue(result.issuesComplete);
    }
  }),
);

it.effect("reads Projects while the milestone page is still in flight", () =>
  Effect.gen(function* () {
    const projectRequested = yield* Deferred.make<void>();
    const harness = makeHarness({
      responses: [httpResponse([rawIssue(7)]), httpResponse([]), httpResponse({ data: {} })],
      onRequest: (call) =>
        call.url.endsWith("/graphql")
          ? Deferred.succeed(projectRequested, undefined).pipe(Effect.asVoid)
          : call.url.includes("/milestones?")
            ? Deferred.await(projectRequested)
            : Effect.void,
    });
    const result = yield* (yield* service(harness)).list(listInput);
    assert.equal(result.issues[0]?.number, 7);
    assert.equal(harness.calls.length, 3);
  }),
);

it.effect("keeps the issue list usable without Project scope or access", () =>
  Effect.gen(function* () {
    for (const response of [
      httpResponse({
        errors: [{ type: "INSUFFICIENT_SCOPES", message: "Requires read:project scope" }],
      }),
      httpResponse({
        data: {
          p0: {
            issue: {
              projectItems: projectConnection([
                projectItem("one", "Planning", projectField("Todo")),
              ]),
            },
          },
        },
        errors: [{ type: "INSUFFICIENT_SCOPES", message: "Requires read:project scope" }],
      }),
      httpResponse({ data: null, errors: [{ type: "NOT_FOUND" }] }),
      httpResponse({ message: "Forbidden" }, {}, 403),
      httpResponse({ data: { p0: null } }),
    ]) {
      const harness = makeHarness({
        responses: [httpResponse([rawIssue(7)]), httpResponse([]), response],
      });
      const result = yield* (yield* service(harness)).list(listInput);
      assert.equal(result.issues[0]?.number, 7);
      assert.deepEqual(result.issues[0]?.projects, []);
      assert.isTrue(result.issuesComplete);
    }
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
      responses: [httpResponse({ message: "secondary rate limit" }, { "Retry-After": "10" }, 403)],
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
      responses: [
        httpResponse(graphQlDetail(graphQlIssue({ body: null }))),
        httpResponse({ data: {} }),
      ],
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

it.effect("reads issue detail, comments, linked pull requests and list relationships", () =>
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
        // The list's metadata read for this issue: an open blocker and a Project status.
        httpResponse({
          data: {
            p0: {
              issue: {
                parent: null,
                blockedBy: {
                  nodes: [{ number: 3, state: "OPEN", repository: { nameWithOwner: REPOSITORY } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                closedByPullRequestsReferences: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                projectItems: projectConnection([
                  projectItem("P1", "Board", projectField("In progress")),
                ]),
              },
            },
          },
        }),
      ],
    });
    const issues = yield* service(harness);
    const detail = yield* issues.detail({ ...listInput, number: 7 });

    assert.equal(harness.calls.length, 2);
    assert.include(harness.calls[0]!.url, "graphql");
    // The detail carries the relationships its list row has, so it can say blocked.
    assert.deepEqual(
      detail.issue.blockedBy?.map((blocker) => [blocker.number, blocker.state]),
      [[3, "open"]],
    );
    assert.equal(detail.issue.projects?.[0]?.status, "In progress");
    assert.notProperty(detail.issue, "pullRequestRefs");
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
        httpResponse({ data: {} }),
      ],
    });
    const detail = yield* (yield* service(harness)).detail({ ...listInput, number: 7 });

    assert.equal(detail.issue.number, 7);
    assert.deepEqual(detail.linkedPullRequests, []);
    assert.equal(harness.calls.length, 3);
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
      responses: [httpResponse({ errors: [{ type: "RATE_LIMITED", message: "limit" }] })],
    });
    const limitedError = yield* (yield* service(limited))
      .detail({ ...listInput, number: 7 })
      .pipe(Effect.flip);
    assert.equal(limitedError.code, "rate-limited");
    assert.equal(limited.rateLimitRecords.length, 1);
  }),
);

it.effect.each([
  [401, "GitHubApiAuthenticationError", "unauthenticated"],
  [429, "GitHubApiRateLimitError", "rate-limited"],
  [404, "GitHubApiNotFoundError", "inaccessible"],
] as const)(
  "classifies an empty GraphQL %i and applies the request policy",
  ([status, tag, code]) => {
    const harness = makeHarness({
      responses: Array.from({ length: 2 }, () => ({
        body: null,
        status,
        headers: status === 429 ? { "retry-after": "10" } : {},
      })),
    });
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* api
        .graphql({ host: HOST, operation: "fixture", query: "query { viewer { login } }" })
        .pipe(Effect.flip);
      assert.equal(error._tag, tag);
      if (error._tag === "GitHubApiRateLimitError") {
        assert.equal(error.retryAt, now + 10_000);
      }
      assert.deepEqual(harness.invalidatedHosts, status === 401 ? [HOST] : []);
      const backoff = { provider: "github", host: HOST, lease: 0, retryAt: now + 10_000 };
      assert.deepEqual(harness.rateLimitRecords, status === 429 ? [backoff] : []);

      const issues = yield* IssueService.make();
      const issueError = yield* issues.detail({ ...listInput, number: 7 }).pipe(Effect.flip);
      assert.equal(issueError.code, code);
      assert.deepEqual(harness.invalidatedHosts, status === 401 ? [HOST, HOST] : []);
      assert.deepEqual(harness.rateLimitRecords, status === 429 ? [backoff, backoff] : []);
      assert.equal(harness.calls.length, 2);
    }).pipe(Effect.provide(harness.layer));
  },
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

it.effect(
  "batches native parents, closed and external blockers, and PR references with Project fields",
  () =>
    Effect.gen(function* () {
      const related = (number: number, state = "OPEN", repository = REPOSITORY) => ({
        number,
        state,
        repository: { nameWithOwner: repository },
      });
      const node = (blockedBy: unknown, parent: unknown = null) => ({
        parent,
        blockedBy,
        projectItems: projectConnection([]),
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 20,
              title: "Fix",
              url: `https://github.com/${REPOSITORY}/pull/20`,
              state: "OPEN",
              isDraft: true,
              updatedAt: "2026-10-15T00:00:00Z",
              repository: { nameWithOwner: REPOSITORY },
            },
          ],
        },
        timelineItems: {
          nodes: [
            {
              source: {
                __typename: "Issue",
                number: 99,
                repository: { nameWithOwner: REPOSITORY },
              },
            },
            {
              source: {
                __typename: "PullRequest",
                number: 21,
                repository: { nameWithOwner: "other/repo" },
              },
            },
          ],
        },
      });
      const harness = makeHarness({
        responses: [
          httpResponse([rawIssue(7), rawIssue(8)]),
          httpResponse([]),
          httpResponse({
            data: {
              p0: {
                issue: node(
                  projectConnection([related(1), related(2, "CLOSED")], "next-blocker"),
                  related(9),
                ),
              },
              p1: { issue: node(projectConnection([])) },
            },
          }),
          httpResponse({
            data: {
              p0: {
                issue: node(projectConnection([related(3, "OPEN", "other/repo")]), related(9)),
              },
            },
          }),
        ],
      });
      const result = yield* (yield* service(harness)).list({ ...listInput, roadmap: true });
      assert.deepEqual(result.issues[0]?.parent, { ...listInput, number: 9 });
      assert.deepEqual(result.issues[0]?.blockedBy, [
        { ...listInput, number: 1, state: "open" },
        { ...listInput, number: 2, state: "closed" },
        { ...listInput, repository: "other/repo", number: 3, state: "open" },
      ]);
      assert.equal(result.issues[0]?.relationshipsComplete, true);
      assert.deepEqual(result.issues[0]?.pullRequestRefs, [{ ...listInput, number: 20 }]);
      assert.deepEqual(result.issues[0]?.pullRequests, [
        {
          ...listInput,
          number: 20,
          title: "Fix",
          url: `https://github.com/${REPOSITORY}/pull/20`,
          state: "open",
          isDraft: true,
          updatedAt: "2026-10-15T00:00:00Z",
        },
      ]);
      assert.deepEqual(result.issues[1]?.blockedBy, []);
      assert.equal(harness.calls.length, 4);
      const first = yield* decodeProjectRequest(harness.calls[2]!.body!);
      assert.deepEqual([first.variables.number0, first.variables.number1], [7, 8]);
      assert.include(first.query, "blockedBy(first: 100");
      assert.include(first.query, "parent {");
      assert.include(first.query, "closedByPullRequestsReferences(");
      assert.notInclude(first.query, "timelineItems");
      const second = yield* decodeProjectRequest(harness.calls[3]!.body!);
      assert.equal(second.variables.blocker0, "next-blocker");
      assert.equal(second.variables.number0, 7);
    }),
);

it.effect(
  "preserves native relationships when Project access fails and marks partial blockers unavailable",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        responses: [
          httpResponse([rawIssue(7), rawIssue(8)]),
          httpResponse([]),
          httpResponse({
            errors: [
              { path: ["p0", "issue", "projectItems"] },
              { path: ["p1", "issue", "blockedBy"] },
            ],
            data: {
              p0: { issue: { parent: null, blockedBy: projectConnection([]), projectItems: null } },
              p1: { issue: { parent: null, blockedBy: null, projectItems: projectConnection([]) } },
            },
          }),
        ],
      });
      const result = yield* (yield* service(harness)).list({ ...listInput, roadmap: true });
      assert.equal(result.issues[0]?.relationshipsComplete, true);
      assert.deepEqual(result.issues[0]?.projects, []);
      assert.equal(result.issues[1]?.relationshipsComplete, false);
    }),
);

it.effect(
  "finishes Project and blocker pagination independently without restarting an exhausted connection",
  () =>
    Effect.gen(function* () {
      const connection = (nodes: unknown[], cursor: string | null = null) =>
        projectConnection(nodes, cursor);
      const blocked = (number: number) => ({
        number,
        state: "OPEN",
        repository: { nameWithOwner: REPOSITORY },
      });
      const answer = (projectCursor: string | null, blockerCursor: string | null, number: number) =>
        httpResponse({
          data: {
            p0: {
              issue: {
                parent: null,
                projectItems: connection([projectItem("project", "Project")], projectCursor),
                blockedBy: connection([blocked(number)], blockerCursor),
              },
            },
          },
        });
      const harness = makeHarness({
        responses: [
          httpResponse([rawIssue(7)]),
          httpResponse([]),
          answer("project-next", "block-next", 1),
          answer(null, "block-last", 2),
          httpResponse({
            data: { p0: { issue: { parent: null, blockedBy: connection([blocked(3)]) } } },
          }),
        ],
      });
      const result = yield* (yield* service(harness)).list({ ...listInput, roadmap: true });
      assert.equal(harness.calls.length, 5);
      assert.deepEqual(
        result.issues[0]?.blockedBy?.map((issue) => issue.number),
        [1, 2, 3],
      );
      assert.equal(result.issues[0]?.relationshipsComplete, true);
      assert.equal(result.issues[0]?.projects?.length, 1);
      const last = yield* decodeProjectRequest(harness.calls[4]!.body!);
      assert.notInclude(last.query, "projectItems(");
      assert.equal(last.variables.blocker0, "block-last");
      assert.notProperty(last.variables, "cursor0");
    }),
);

it.effect("paginates closing PR references without restarting completed metadata connections", () =>
  Effect.gen(function* () {
    const pr = (number: number) => ({ number, repository: { nameWithOwner: REPOSITORY } });
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7)]),
        httpResponse([]),
        httpResponse({
          data: {
            p0: {
              issue: {
                parent: null,
                blockedBy: projectConnection([]),
                projectItems: projectConnection([]),
                closedByPullRequestsReferences: projectConnection([pr(1)], "next-pr"),
              },
            },
          },
        }),
        httpResponse({
          data: {
            p0: {
              issue: {
                parent: null,
                closedByPullRequestsReferences: projectConnection([pr(3)]),
              },
            },
          },
        }),
      ],
    });
    const result = yield* (yield* service(harness)).list({ ...listInput, roadmap: true });
    assert.deepEqual(
      result.issues[0]?.pullRequestRefs?.map((pr) => pr.number),
      [1, 3],
    );
    assert.equal(result.issues[0]?.relationshipsComplete, true);
    assert.equal(harness.calls.length, 4);
    const last = yield* decodeProjectRequest(harness.calls[3]!.body!);
    assert.equal(last.variables.pullRequest0, "next-pr");
    assert.notInclude(last.query, "projectItems(");
    assert.notInclude(last.query, "blockedBy(");
    assert.notInclude(last.query, "timelineItems");
  }),
);

it.effect("Milestones and default page reads request only Project metadata", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawIssue(7), rawIssue(8)]),
        httpResponse([]),
        httpResponse({
          data: {
            p0: { issue: { projectItems: projectConnection([projectItem("p", "Project")]) } },
            p1: { issue: { projectItems: projectConnection([]) } },
          },
        }),
      ],
    });
    const result = yield* (yield* service(harness)).list(listInput);
    assert.equal(harness.calls.length, 3);
    const request = yield* decodeProjectRequest(harness.calls[2]!.body!);
    assert.include(request.query, "projectItems(");
    for (const field of [
      "blockedBy",
      "parent {",
      "closedByPullRequestsReferences",
      "timelineItems",
    ])
      assert.notInclude(request.query, field);
    assert.deepEqual(Object.keys(request.variables).sort(), [
      "cursor0",
      "cursor1",
      "name",
      "number0",
      "number1",
      "owner",
    ]);
    assert.equal(result.issues[0]?.projects?.length, 1);
    assert.notProperty(result.issues[0]!, "blockedBy");
    assert.notProperty(result.issues[0]!, "pullRequestRefs");
  }),
);

it.effect("fetches closed issues in all-state roadmap reads and retains actual closure time", () =>
  Effect.gen(function* () {
    const closedAt = "2026-10-19T12:00:00Z";
    const harness = makeHarness({
      responses: [
        httpResponse([
          rawIssue(1, {
            state: "closed",
            state_reason: "completed",
            closed_at: closedAt,
            updated_at: "2026-10-20T12:00:00Z",
          }),
        ]),
        httpResponse([]),
        httpResponse({ data: {} }),
      ],
    });
    const issues = yield* service(harness);
    const result = yield* issues.list({ ...listInput, state: "all", roadmap: true });
    assert.equal(result.issues[0]?.state, "closed");
    assert.equal(result.issues[0]?.closedAt, closedAt);
    assert.include(harness.calls[0]!.url, "state=all");
  }),
);
