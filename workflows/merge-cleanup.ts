import { completionState, namedGitHubIssues } from "./lib/merge-cleanup.ts";

declare const T3: typeof import("../apps/server/src/workflows/api.ts");
declare const Effect: typeof T3.Effect;
declare const Schema: typeof T3.Schema;
declare const Option: typeof T3.Option;

const {
  issues,
  pullRequests,
  PullRequest,
  threads,
  WorktreeRemoval,
  skip,
  step,
  subject,
  title,
  workflow,
} = T3;

const plan = Schema.Struct({
  threads: Schema.Array(Schema.String),
  issues: Schema.Array(Schema.Struct({ project: Schema.String, url: Schema.String })),
  cwd: Schema.String,
  branch: Schema.String,
  headSha: Schema.optional(Schema.String),
  canDeleteBranch: Schema.Boolean,
});

export default workflow(
  "merge-cleanup",
  { version: 1, payload: PullRequest, triggers: [pullRequests.opened()] },
  Effect.fn(function* (pullRequest) {
    yield* title(`Clean up ${pullRequest.repository} #${pullRequest.number}`);
    yield* subject(pullRequest);
    const end = yield* pullRequests.wait("merge", pullRequest, { until: "merged" });
    if (Option.isNone(end) || end.value.state !== "merged")
      return yield* skip("PR closed without merging");

    const cleanup = yield* step(
      "find child work",
      { returns: plan },
      Effect.gen(function* () {
        const detail = yield* pullRequests.read(pullRequest);
        if (detail.state !== "merged")
          return yield* Effect.die(new Error("PR must still be merged."));
        const linked = yield* pullRequests.linkedThreads(pullRequest);
        const children = linked.filter(
          (thread) =>
            thread.projectId === pullRequest.projectId &&
            (thread.lineage.relationshipToParent === "subagent" || thread.delegatedFrom != null) &&
            thread.lineage.sideChat !== true &&
            thread.branch === detail.headBranch &&
            thread.pullRequests?.some(
              (link) =>
                (link.source === "agent" || link.source === "created") &&
                link.number === pullRequest.number &&
                link.host === pullRequest.host &&
                link.repository.toLowerCase() === pullRequest.repository.toLowerCase(),
            ) === true,
        );
        const named =
          detail.provider === "github"
            ? namedGitHubIssues({ ...pullRequest, title: detail.title, body: detail.body })
            : [];
        const addresses = [
          ...children.flatMap((thread) =>
            (thread.issues ?? [])
              .filter((issue) => issue.source !== "child")
              .map((issue) => ({ project: issue.projectId, url: issue.url })),
          ),
          ...named.map((url) => ({ project: pullRequest.projectId, url })),
        ];
        return {
          threads: children.map((child) => child.id),
          issues: [...new Map(addresses.map((issue) => [issue.url.toLowerCase(), issue])).values()],
          cwd: detail.workspaceRoot,
          branch: detail.headBranch,
          ...(detail.headSha === undefined || detail.headBranch === detail.baseBranch
            ? {}
            : { headSha: detail.headSha }),
          canDeleteBranch: detail.capabilities.deleteBranch === true,
        };
      }),
    );
    if (cleanup.threads.length === 0)
      return yield* skip("No child thread owns this PR's head branch");

    const worktrees = [];
    for (const [index, threadId] of cleanup.threads.entries()) {
      yield* step(
        `archive child ${index + 1}`,
        { returns: Schema.Boolean },
        threads.archive(threadId, `workflow:merge-cleanup:${pullRequest.url}:${threadId}`),
      );
      const headSha = cleanup.headSha;
      const worktree = yield* step(
        `remove worktree ${index + 1}`,
        { returns: WorktreeRemoval },
        headSha === undefined
          ? Effect.succeed({
              removed: false,
              kept: "The PR has no safe head commit to remove.",
              localBranchDeleted: false,
            })
          : threads.removeWorktree({ threadId, cwd: cleanup.cwd, branch: cleanup.branch, headSha }),
      );
      worktrees.push({ threadId, ...worktree });
    }

    const branch = yield* step(
      "delete remote head branch",
      { returns: Schema.String },
      cleanup.headSha === undefined || !cleanup.canDeleteBranch
        ? Effect.succeed("Host does not provide a safe branch deletion for this PR.")
        : pullRequests
            .act(pullRequest, "delete-branch")
            .pipe(Effect.as("Head branch deleted or already absent.")),
    );

    const completed = [];
    for (const [index, issue] of cleanup.issues.entries()) {
      completed.push(
        yield* step(
          `complete issue ${index + 1}`,
          { returns: Schema.String },
          Effect.gen(function* () {
            const detail = yield* issues.read(issue);
            const done = completionState(detail.states);
            if (done === undefined) return `${issue.url} has no Done or completed state.`;
            if (detail.state.name !== done.name) yield* issues.setState(issue, done.name);
            return `${issue.url} → ${done.name}`;
          }),
        ),
      );
    }
    return { worktrees, branch, issues: completed };
  }),
);
