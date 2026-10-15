import { assert, it } from "@effect/vitest";
import { IssueLinkError, IssueReadError, type IssueListResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IssueService from "./IssueService.ts";
import * as IssueLinks from "./IssueLinks.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";

const input = { host: "github.com", repository: "owner/repo" };
const list: IssueListResult = {
  repository: input,
  viewer: null,
  fetchedAt: "2026-10-13T00:00:00Z",
  milestones: [],
  nextCursor: null,
  issuesComplete: true,
  milestonesComplete: true,
  issues: [
    {
      number: 13,
      title: "Roadmap",
      url: "https://github.com/owner/repo/issues/13",
      state: "open",
      stateReason: null,
      author: null,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      commentCount: 0,
      blockedBy: [],
      parent: null,
      relationshipsComplete: true,
      pullRequestRefs: [{ ...input, number: 42 }],
    },
  ],
};

it.effect(
  "skips local work for Milestones and keeps Roadmap issues when optional link storage fails",
  () => {
    let reads = 0;
    const layer = IssueRoadmap.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(IssueService.IssueService)({ list: () => Effect.succeed(list) }),
          Layer.mock(IssueLinks.IssueLinks)({
            enrich: () =>
              Effect.gen(function* () {
                reads++;
                return yield* new IssueLinkError({ code: "storage", cause: "unavailable" });
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const roadmap = yield* IssueRoadmap.IssueRoadmap;
      assert.strictEqual(yield* roadmap.list(input), list);
      assert.strictEqual(yield* roadmap.list({ ...input, roadmap: false }), list);
      assert.equal(reads, 0);
      const result = yield* roadmap.list({ ...input, roadmap: true });
      assert.equal(reads, 1);
      assert.equal(result.issues[0]?.title, "Roadmap");
      assert.deepEqual(result.issues[0]?.blockedBy, []);
      assert.deepEqual(result.issues[0]?.liveWork, []);
      assert.notProperty(result.issues[0]!, "pullRequestRefs");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("preserves an underlying GitHub read failure", () => {
  const error = new IssueReadError({
    code: "upstream",
    operation: "list",
    message: "GitHub unavailable",
  });
  const layer = IssueRoadmap.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(IssueService.IssueService)({ list: () => Effect.fail(error) }),
        Layer.mock(IssueLinks.IssueLinks)({
          enrich: () => Effect.die("should not enrich a failed list"),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const roadmap = yield* IssueRoadmap.IssueRoadmap;
    assert.strictEqual(yield* roadmap.list({ ...input, roadmap: true }).pipe(Effect.flip), error);
  }).pipe(Effect.provide(layer));
});

it.effect("gives an issue's detail the live work its row has, matched by closing PRs", () => {
  const { pullRequestRefs: _refs, ...summary } = list.issues[0]!;
  const detail = {
    repository: input,
    viewer: null,
    fetchedAt: "2026-10-13T00:00:00Z",
    issue: summary,
    body: "",
    comments: [],
    linkedPullRequests: [
      {
        repository: "owner/repo",
        number: 42,
        title: "Closes",
        state: "open" as const,
        isDraft: false,
        url: "https://github.com/owner/repo/pull/42",
        closesIssue: true,
      },
      {
        repository: "owner/repo",
        number: 43,
        title: "Mentions",
        state: "open" as const,
        isDraft: false,
        url: "https://github.com/owner/repo/pull/43",
        closesIssue: false,
      },
    ],
  };
  let enriched: IssueListResult | undefined;
  const layer = IssueRoadmap.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(IssueService.IssueService)({ detail: () => Effect.succeed(detail) }),
        Layer.mock(IssueLinks.IssueLinks)({
          enrich: (value) => {
            enriched = value;
            return Effect.succeed({
              ...value,
              issues: value.issues.map(({ pullRequestRefs: _ignored, ...issue }) => ({
                ...issue,
                liveWork: [],
              })),
            });
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const result = yield* (yield* IssueRoadmap.IssueRoadmap).detail({ ...input, number: 13 });
    assert.deepEqual(enriched?.issues[0]?.pullRequestRefs, [{ ...input, number: 42 }]);
    assert.deepEqual(result.issue.liveWork, []);
    assert.equal(result.linkedPullRequests.length, 2);
  }).pipe(Effect.provide(layer));
});
