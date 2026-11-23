import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ThreadId } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "./IssueGitHubApi.ts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";

import * as IssueService from "./IssueService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";
import * as IssueLinks from "./IssueLinks.ts";
import * as TrackerIssueService from "../issue/IssueService.ts";

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
  const verifiedRepositories: Array<string | undefined> = [];
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
      saved: () => Effect.succeedNone,
      fingerprint: (host) => Effect.succeed(`${host}:token`),
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
    withVerifiedCredential: (request, use) => {
      verifiedRepositories.push(request.repository);
      return input.verificationError !== undefined &&
        (input.verificationErrorHost === undefined || input.verificationErrorHost === request.host)
        ? Effect.fail(input.verificationError)
        : use({
            accountId: input.accountId ?? ACCOUNT_ID,
            viewer: "octocat",
            credentialFingerprint: input.credentialFingerprint?.() ?? "credential-fingerprint",
          });
    },
  });
  const layer = Layer.mergeAll(api, verifier);
  return { layer, calls, rateLimitRecords, invalidatedHosts, verifiedRepositories };
}

function service(harness: ReturnType<typeof makeHarness>) {
  return Effect.gen(function* () {
    const dependencies = yield* Layer.build(harness.layer);
    return yield* IssueService.make().pipe(Effect.provideContext(dependencies));
  });
}

const listInput = {
  host: HOST,
  repository: REPOSITORY,
};

it.effect(
  "reuses live status reads until expiry, explicit refresh, credential change or a write",
  () =>
    Effect.gen(function* () {
      const status = (state = "OPEN") =>
        httpResponse({
          data: {
            nodes: [
              {
                __typename: "Issue",
                id: "I_7",
                number: 7,
                repository: { nameWithOwner: REPOSITORY },
                state,
                stateReason: null,
                blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            ],
          },
        });
      let credential = "reader";
      const harness = makeHarness({
        credentialFingerprint: () => credential,
        responses: [
          status(),
          status(),
          status(),
          status(),
          httpResponse({}),
          status("CLOSED"),
          httpResponse({
            id: 99,
            html_url: `https://${HOST}/${REPOSITORY}/issues/7#issuecomment-99`,
          }),
          status(),
        ],
      });
      const issues = yield* service(harness);
      let working = false;
      let enrichments = 0;
      const roadmapContext = yield* Layer.build(
        IssueRoadmap.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(IssueService.IssueService, issues),
              Layer.mock(TrackerIssueService.IssueService)({}),
              SqlitePersistence.layerMemory,
              Layer.mock(IssueLinks.IssueLinks)({
                enrich: (list) =>
                  Effect.sync(() => {
                    enrichments++;
                    return {
                      ...list,
                      issues: list.issues.map((issue) => ({
                        ...issue,
                        liveWork: [
                          {
                            threadId: ThreadId.make("builder"),
                            inherited: false,
                            status: working ? ("working" as const) : ("idle" as const),
                            title: "Builder",
                            branch: null,
                            worktreePath: null,
                            pullRequests: [],
                          },
                        ],
                      })),
                    };
                  }),
              }),
            ),
          ),
        ),
      );
      const roadmap = yield* IssueRoadmap.IssueRoadmap.pipe(Effect.provideContext(roadmapContext));
      const input = { issues: [{ host: HOST, nodeId: "I_7" }] };
      const first = yield* roadmap.statusBatch(input);
      assert.equal(first[0]?.liveWork?.[0]?.status, "idle");
      for (let index = 0; index < 10; index++) {
        working = index % 2 === 0;
        const result = yield* roadmap.statusBatch(input);
        assert.equal(result[0]?.state, "open");
        assert.equal(result[0]?.liveWork?.[0]?.status, working ? "working" : "idle");
      }
      assert.equal(harness.calls.length, 1, "local link refreshes must reuse GitHub states");
      assert.equal(enrichments, 11);
      yield* TestClock.adjust("59999 millis");
      yield* issues.statusBatch(input);
      assert.equal(harness.calls.length, 1);
      yield* TestClock.adjust("1 millis");
      yield* issues.statusBatch(input);
      assert.equal(harness.calls.length, 2);
      yield* issues.statusBatch({ ...input, refresh: true });
      yield* issues.statusBatch(input);
      assert.equal(harness.calls.length, 3);
      credential = "writer";
      yield* issues.statusBatch(input);
      assert.equal(harness.calls.length, 4);
      yield* issues.setMilestone({ ...listInput, number: 7, milestoneNumber: null });
      credential = "reader";
      assert.equal((yield* issues.statusBatch(input))[0]?.state, "closed");
      assert.equal(harness.calls.length, 6);
      yield* issues.postComment({ ...listInput, number: 7 }, "Update");
      assert.equal((yield* issues.statusBatch(input))[0]?.state, "open");
      assert.equal(harness.calls.length, 8, "inbox writes must invalidate live status reads");
    }),
);

it.effect("shares an in-flight status read between concurrent link refreshes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = makeHarness({
      responses: [httpResponse({ data: { nodes: [] } })],
      onRequest: () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    const issues = yield* service(harness);
    const input = { issues: [{ host: HOST, nodeId: "I_7" }], refresh: false };
    const reads = yield* Effect.all(
      Array.from({ length: 10 }, () => issues.statusBatch(input)),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust(0);
    assert.equal(harness.calls.length, 1);
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(
      yield* Fiber.join(reads),
      Array.from({ length: 10 }, () => []),
    );
  }),
);

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
      const issues = yield* service(harness);
      const result = yield* issues.statusBatch({ issues: [...refs, refs[0]!] });
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
      assert.deepEqual(
        yield* issues.statusBatch({
          issues: refs.toReversed().map((ref) => ({ ...ref, host: ref.host.toUpperCase() })),
          refresh: false,
        }),
        result,
      );
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
      assert.deepEqual(read.issue, {
        host: HOST,
        repository: REPOSITORY,
        repositoryId: "123",
        id: "2",
        nodeId: "node:2",
        number: 2,
        title: "Issue 2",
        url: `https://${HOST}/${REPOSITORY}/issues/2`,
      });
      assert.deepEqual(
        harness.calls.map(({ method, url }) => [method, new URL(url).pathname]),
        [["POST", "/api/graphql"]],
      );
      assert.equal(read.parent?.number, 1);
      assert.equal(read.subIssues[0]?.number, 3);
      assert.equal(read.blockedBy[0]?.state, "closed");
      assert.isTrue(read.parentComplete && read.blockersComplete && read.subIssuesComplete);
      const pullRequestNumber = makeHarness({
        responses: [
          httpResponse({
            data: { repository: { issue: null } },
            errors: [{ type: "NOT_FOUND", path: ["repository", "issue"] }],
          }),
        ],
      });
      const pullRequestError = yield* (yield* service(pullRequestNumber))
        .workRead({ ...listInput, number: 8 })
        .pipe(Effect.flip);
      assert.equal(pullRequestError.code, "inaccessible");
      assert.include(pullRequestNumber.calls[0]!.body, "issue(number: $number)");
      const requestedIssue = payload.data.repository.issue;
      for (const issue of [
        { ...requestedIssue, number: 7 },
        {
          ...requestedIssue,
          repository: { ...requestedIssue.repository, nameWithOwner: "acme/other" },
        },
      ]) {
        const mismatched = makeHarness({
          responses: [httpResponse({ data: { repository: { issue } } })],
        });
        const error = yield* (yield* service(mismatched))
          .workRead({ ...listInput, number: 2 })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid-response");
      }
      const partial = makeHarness({
        responses: [httpResponse({ ...payload, errors: [{ message: "Forbidden" }] })],
      });
      const partialError = yield* (yield* service(partial))
        .workRead({ ...listInput, number: 2 })
        .pipe(Effect.flip);
      assert.equal(partialError.code, "invalid-response");
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

it.effect("finds T3's comment by its marker and rewrites it in place", () =>
  Effect.gen(function* () {
    const marker = "<!-- t3-issue-status:github.com:123:456 -->";
    const harness = makeHarness({
      responses: [
        httpResponse([
          { id: 788, body: "Someone else" },
          { id: 789, body: `Working\n\n${marker}` },
        ]),
        httpResponse({}),
      ],
    });
    const issues = yield* service(harness);
    const issue = {
      host: HOST,
      repository: REPOSITORY,
      repositoryId: "123",
      id: "456",
      nodeId: "I_kwDOIssue456",
      number: 7,
      url: `https://${HOST}/${REPOSITORY}/issues/7`,
      title: "Stable identity",
    };
    const comment = yield* issues.findManagedComment({ issue, marker });
    assert.equal(comment?.id, "789");
    yield* issues.updateManagedComment({
      issue,
      commentId: comment!.id,
      body: `Done\n\n${marker}`,
    });
    assert.equal(harness.calls[1]!.method, "PATCH");
    assert.isTrue(harness.calls[1]!.url.endsWith("/repos/acme/web/issues/comments/789"));
    assert.deepEqual(yield* decodeJson(harness.calls[1]!.body!), { body: `Done\n\n${marker}` });
  }),
);

it.effect("finds an earlier create by the marker in its body, skipping pull requests", () =>
  Effect.gen(function* () {
    const marker = "<!-- t3-issue-change:proposal:0 -->";
    const created = {
      ...rawIssue(7),
      id: 456,
      node_id: "I_456",
      html_url: `https://${HOST}/${REPOSITORY}/issues/7`,
      body: `Exact body\n\n${marker}`,
    };
    const pullRequest = { ...created, id: 455, number: 6, pull_request: {} };
    const harness = makeHarness({
      responses: [
        httpResponse({ id: 123, node_id: "R_123", full_name: REPOSITORY }),
        httpResponse([pullRequest, created]),
      ],
    });
    const issues = yield* service(harness);
    yield* issues.withRepositoryCredential(listInput, Effect.void);
    const found = yield* issues.findCreatedIssue({ ...listInput, marker });
    assert.equal(found?.issue.id, "456");
    assert.deepEqual(harness.verifiedRepositories, [REPOSITORY, REPOSITORY]);
    assert.isTrue(harness.calls.every((call) => call.method === "GET"));
  }),
);

it.effect("writes milestone and native sub-issue relations through verified GitHub APIs", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ responses: Array.from({ length: 5 }, () => httpResponse({})) });
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
    const child = { ...parent, number: 8, id: "789", nodeId: "I_789" };
    yield* issues.setMilestone({ ...ref, milestoneNumber: null });
    yield* issues.setParent({ parent, child, action: "add" });
    yield* issues.setParent({ parent, child, action: "remove" });
    yield* issues.setBlockedBy({ issue: parent, blocker: child, action: "add" });
    yield* issues.setBlockedBy({ issue: parent, blocker: child, action: "remove" });
    const payloads = yield* Effect.forEach(harness.calls.slice(0, 3), (call) =>
      decodeJson(call.body!),
    );
    assert.deepEqual(payloads, [{ milestone: null }, { sub_issue_id: 789 }, { sub_issue_id: 789 }]);
    for (const [index, mutation] of ["addBlockedBy", "removeBlockedBy"].entries()) {
      const call = harness.calls[index + 3]!;
      assert.isTrue(call.url.endsWith("/graphql"));
      const payload = yield* decodeJson(call.body!);
      assert.deepEqual(payload, {
        query: `mutation($issueId: ID!, $blockingIssueId: ID!) { ${mutation}(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { clientMutationId } }`,
        variables: { issueId: "I_456", blockingIssueId: "I_789" },
      });
    }
    assert.equal(harness.calls[1]!.method, "POST");
    assert.isTrue(harness.calls[1]!.url.endsWith("/repos/acme/web/issues/7/sub_issues"));
    assert.equal(harness.calls[2]!.method, "DELETE");
    assert.isTrue(harness.calls[2]!.url.endsWith("/repos/acme/web/issues/7/sub_issue"));
  }),
);

it.effect("issue writes surface permission failures and respect the shared rate limit", () =>
  Effect.gen(function* () {
    const denied = makeHarness({ responses: [httpResponse({ message: "Forbidden" }, {}, 403)] });
    const deniedResult = yield* Effect.result(
      (yield* service(denied)).setMilestone({ ...listInput, number: 7, milestoneNumber: 2 }),
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
      (yield* service(limited)).setMilestone({ ...listInput, number: 7, milestoneNumber: null }),
    );
    assert.isTrue(Result.isFailure(limitedResult));
    if (Result.isFailure(limitedResult)) {
      assert.equal(limitedResult.failure.code, "rate-limited");
      assert.isDefined(limitedResult.failure.retryAt);
    }
    assert.equal(limited.rateLimitRecords.length, 1);
  }),
);

it.effect("revalidates milestone pages, retaining their decoded bodies and pagination on 304", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([rawMilestone(1)], {
          etag: '"milestones-1"',
          link: `<https://${HOST}/milestones?page=2>; rel="next"`,
        }),
        { status: 304, body: null },
      ],
    });
    const issues = yield* service(harness);
    const input = { ...listInput, state: "open" as const, page: 1 };
    const first = yield* issues.milestones(input);
    const warm = yield* issues.milestones(input);
    assert.deepEqual(warm.items, first.items);
    assert.equal(warm.nextPage, 2);
    assert.equal(harness.calls[1]!.ifNoneMatch, '"milestones-1"');
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

it.effect("rejects a repository that cannot be addressed before calling GitHub", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ responses: [] });
    const issues = yield* service(harness);
    const error = yield* issues
      .milestones({ host: HOST, repository: "not-a-repository", state: "open", page: 1 })
      .pipe(Effect.flip);

    assert.equal(error.code, "scope-unavailable");
    assert.deepEqual(harness.calls, []);
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
    const result = Option.getOrThrow(
      yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7, 8] }),
    );
    assert.deepEqual(result.get(7)?.projects, [
      {
        id: "one",
        title: "Planning",
        status: "In Progress",
        priority: { name: "Urgent", rank: 1 },
      },
      { id: "two", title: "Delivery", status: null, priority: { name: "High", rank: 0 } },
    ]);
    assert.deepEqual(result.get(8)?.projects, []);
    assert.equal(harness.calls.length, 1);
    const request = yield* decodeProjectRequest(harness.calls[0]!.body!);
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
    const result = Option.getOrThrow(
      yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7] }),
    );
    assert.deepEqual(result.get(7)?.projects, [
      { id: "one", title: "Planning", status: "Todo", priority: { name: "Custom", rank: null } },
      { id: "two", title: "Delivery", status: null, priority: null },
    ]);
    assert.equal(harness.calls.length, 2);
    const request = yield* decodeProjectRequest(harness.calls[1]!.body!);
    assert.equal(request.variables.cursor0, "projects-1");
    assert.notInclude(request.query, "node(id:");
  }),
);

it.effect("keeps other issues' Project chips when an aliased issue fails", () =>
  Effect.gen(function* () {
    for (const type of ["NOT_FOUND", "FORBIDDEN"]) {
      const harness = makeHarness({
        responses: [
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
      const result = Option.getOrThrow(
        yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7, 8] }),
      );
      assert.deepEqual(result.get(7)?.projects, []);
      assert.deepEqual(result.get(8)?.projects, [
        {
          id: "one",
          title: "Planning",
          status: "In Progress",
          priority: { name: "High", rank: 0 },
        },
      ]);
    }
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
        responses: [response, httpResponse({ message: "Forbidden" }, {}, 403)],
      });
      const result = yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7] });
      // A failed read is None, which the roadmap shows as unknown relationships and doesn't keep.
      const facts = Option.getOrUndefined(result)?.get(7);
      assert.deepEqual(facts?.projects ?? [], []);
      assert.notEqual(facts?.relationshipsComplete, true);
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
    const error = yield* issues
      .milestones({ ...listInput, state: "open", page: 1 })
      .pipe(Effect.flip);

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
    const error = yield* issues
      .milestones({ ...listInput, state: "open", page: 1 })
      .pipe(Effect.flip);

    assert.equal(error.code, "rate-limited");
    assert.isTrue(error.retryAt !== undefined);
    assert.equal(harness.rateLimitRecords.length, 1);
    assert.equal(harness.calls.length, 1);
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
          httpResponse({
            data: {
              p0: {
                issue: {
                  ...node(
                    projectConnection([related(1), related(2, "CLOSED")], "next-blocker"),
                    related(9),
                  ),
                  subIssuesSummary: { total: 3, completed: 1 },
                },
              },
              p1: {
                issue: {
                  ...node(projectConnection([])),
                  subIssuesSummary: { total: 0, completed: 0 },
                },
              },
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
      const result = Option.getOrThrow(
        yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7, 8] }),
      );
      assert.deepEqual(result.get(7)?.parent, { ...listInput, number: 9 });
      assert.deepEqual(result.get(7)?.blockedBy, [
        { ...listInput, number: 1, state: "open" },
        { ...listInput, number: 2, state: "closed" },
        { ...listInput, repository: "other/repo", number: 3, state: "open" },
      ]);
      assert.equal(result.get(7)?.relationshipsComplete, true);
      assert.deepEqual(result.get(7)?.subIssues, { total: 3, completed: 1 });
      assert.notProperty(result.get(8), "subIssues");
      assert.deepEqual(result.get(7)?.pullRequestRefs, [{ ...listInput, number: 20 }]);
      assert.deepEqual(result.get(7)?.pullRequests, [
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
      assert.deepEqual(result.get(8)?.blockedBy, []);
      assert.equal(harness.calls.length, 2);
      const first = yield* decodeProjectRequest(harness.calls[0]!.body!);
      assert.deepEqual([first.variables.number0, first.variables.number1], [7, 8]);
      assert.include(first.query, "blockedBy(first: 100");
      assert.include(first.query, "parent {");
      assert.include(first.query, "closedByPullRequestsReferences(");
      assert.notInclude(first.query, "timelineItems");
      const second = yield* decodeProjectRequest(harness.calls[1]!.body!);
      assert.equal(second.variables.blocker0, "next-blocker");
      assert.equal(second.variables.number0, 7);
    }),
);

it.effect("loads roadmap relationships without Project scope, and stops asking for it", () =>
  Effect.gen(function* () {
    const related = (number: number) => ({
      number,
      state: "CLOSED",
      repository: { nameWithOwner: REPOSITORY },
    });
    let credential = "credential-fingerprint";
    const harness = makeHarness({
      credentialFingerprint: () => credential,
      responses: [
        httpResponse({
          errors: [
            {
              type: "INSUFFICIENT_SCOPES",
              message: "The 'id' field requires one of the following scopes: ['read:project']",
            },
          ],
        }),
        httpResponse({
          data: {
            p0: { issue: { parent: null, blockedBy: projectConnection([]) } },
            p1: { issue: { parent: null, blockedBy: projectConnection([related(855)]) } },
            p2: { issue: { parent: null, blockedBy: projectConnection([related(869)], "next") } },
          },
        }),
        httpResponse({
          data: {
            p0: {
              issue: {
                parent: null,
                blockedBy: projectConnection([861, 862, 863, 864].map(related)),
              },
            },
          },
        }),
        httpResponse({ data: { p0: { issue: { parent: null } } } }),
        httpResponse({ data: { p0: { issue: { parent: null, projectItems: null } } } }),
        httpResponse({ data: { p0: { issue: { parent: null, projectItems: null } } } }),
      ],
    });
    const issues = yield* service(harness);
    const result = Option.getOrThrow(
      yield* issues.overlay({
        ...listInput,
        numbers: [948, 868, 860],
      }),
    );
    assert.deepEqual(
      [948, 868, 860].map((number) => result.get(number)?.relationshipsComplete),
      [true, true, true],
    );
    assert.deepEqual(
      [948, 868, 860].map((number) =>
        result.get(number)?.blockedBy?.map((ref) => [ref.number, ref.state]),
      ),
      [
        [],
        [[855, "closed"]],
        [869, 861, 862, 863, 864].map((number) => [number, "closed" as const]),
      ],
    );
    for (const call of harness.calls.slice(1)) {
      const request = yield* decodeProjectRequest(call.body!);
      assert.notInclude(request.query, "projectItems(");
      assert.notProperty(request.variables, "cursor0");
      assert.include(request.query, "blockedBy(");
    }
    assert.equal(harness.calls.length, 3);

    // A manual refresh probes the same token again. A new credential also gets its own probe.
    yield* issues.overlay({ ...listInput, numbers: [948] });
    yield* issues.overlay({ ...listInput, numbers: [948], refresh: true });
    credential = "another-credential";
    yield* issues.overlay({ ...listInput, numbers: [948] });
    const [remembered, refreshed, renewed] = yield* Effect.forEach(harness.calls.slice(3), (call) =>
      decodeProjectRequest(call.body!),
    );
    assert.notInclude(remembered!.query, "projectItems(");
    assert.include(refreshed!.query, "projectItems(");
    assert.include(renewed!.query, "projectItems(");
    assert.equal(harness.calls.length, 6);
  }),
);

it.effect(
  "preserves native relationships when Project access fails and marks partial blockers unavailable",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        responses: [
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
      const result = Option.getOrThrow(
        yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7, 8] }),
      );
      assert.equal(result.get(7)?.relationshipsComplete, true);
      assert.deepEqual(result.get(7)?.projects, []);
      assert.equal(result.get(8)?.relationshipsComplete, false);
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
          answer("project-next", "block-next", 1),
          answer(null, "block-last", 2),
          httpResponse({
            data: { p0: { issue: { parent: null, blockedBy: connection([blocked(3)]) } } },
          }),
        ],
      });
      const result = Option.getOrThrow(
        yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7] }),
      );
      assert.equal(harness.calls.length, 3);
      assert.deepEqual(
        result.get(7)?.blockedBy?.map((issue) => issue.number),
        [1, 2, 3],
      );
      assert.equal(result.get(7)?.relationshipsComplete, true);
      assert.equal(result.get(7)?.projects?.length, 1);
      const last = yield* decodeProjectRequest(harness.calls[2]!.body!);
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
    const result = Option.getOrThrow(
      yield* (yield* service(harness)).overlay({ ...listInput, numbers: [7] }),
    );
    assert.deepEqual(
      result.get(7)?.pullRequestRefs?.map((pr) => pr.number),
      [1, 3],
    );
    assert.equal(result.get(7)?.relationshipsComplete, true);
    assert.equal(harness.calls.length, 2);
    const last = yield* decodeProjectRequest(harness.calls[1]!.body!);
    assert.equal(last.variables.pullRequest0, "next-pr");
    assert.notInclude(last.query, "projectItems(");
    assert.notInclude(last.query, "blockedBy(");
    assert.notInclude(last.query, "timelineItems");
  }),
);

it.effect("inbox labels preserve existing labels and tolerate a failed create", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      responses: [
        httpResponse([{ name: "External" }]),
        httpResponse({ message: "already exists" }, {}, 422),
        httpResponse({}),
        httpResponse([{ name: "other" }]),
        httpResponse([{ name: "decision-needed" }, { name: "other" }]),
        { body: null, status: 204 },
      ],
    });
    const issues = yield* service(harness);
    yield* issues.ensureLabels(listInput, [
      { name: "external", color: "1d76db" },
      { name: "raced", color: "ededed" },
      { name: "high-priority", color: "b60205" },
    ]);
    const ref = { ...listInput, number: 7 };
    yield* issues.setLabels(ref, [], ["decision-needed"]);
    assert.equal(harness.calls.length, 4, "an absent label must not be deleted");
    yield* issues.setLabels(ref, [], ["decision-needed"]);
    assert.deepEqual(
      harness.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body!)),
      [
        { name: "raced", color: "ededed" },
        { name: "high-priority", color: "b60205" },
      ],
    );
    assert.equal(harness.calls[5]?.method, "DELETE");
    assert.isTrue(harness.calls[5]!.url.endsWith("/issues/7/labels/decision-needed"));
  }),
);
