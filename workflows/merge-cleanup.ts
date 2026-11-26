// @effect-diagnostics-next-line nodeBuiltinImport:off -- Trigger paths are validated while the workflow definition loads.
import * as NodePath from "node:path";
import { completionState, namedIssues } from "./lib/merge-cleanup.ts";

declare const T3: typeof import("../apps/server/src/workflows/api.ts");
declare const Effect: typeof T3.Effect;
declare const Option: typeof T3.Option;
declare const Schema: typeof T3.Schema;

const { issues, pullRequests, PullRequest, skip, step, subject, title, workflow } = T3;

const configured: unknown = JSON.parse(process.env.T3_MERGE_CLEANUP_PROJECTS ?? "[]");
if (
  !Array.isArray(configured) ||
  !configured.every((path) => typeof path === "string" && NodePath.isAbsolute(path))
) {
  throw new Error("T3_MERGE_CLEANUP_PROJECTS must be a JSON array of absolute repository paths");
}
const projects: string[] = [...new Set(configured)];

export default workflow(
  "merge-cleanup",
  {
    version: 1,
    payload: PullRequest,
    triggers: projects.map((project) => pullRequests.opened({ project })),
  },
  Effect.fn(function* (pullRequest) {
    yield* title(`Clean up ${pullRequest.repository} #${pullRequest.number}`);
    yield* subject(pullRequest);
    const end = yield* pullRequests.wait("merge", pullRequest, { until: "merged" });
    if (Option.isNone(end) || end.value.state !== "merged")
      return yield* skip("PR closed without merging");

    const cleanup = yield* step(
      "clean up creator",
      {
        returns: Schema.Struct({
          worktree: Schema.NullOr(Schema.String),
          issueUrls: Schema.Array(Schema.String),
          deleteBranch: Schema.Boolean,
        }),
      },
      Effect.gen(function* () {
        const detail = yield* pullRequests.read(pullRequest);
        if (detail.state !== "merged")
          return yield* Effect.die(new Error("PR must still be merged."));
        return {
          worktree: yield* pullRequests.cleanUpCreator({ ...detail, host: pullRequest.host }),
          issueUrls: namedIssues({
            ...pullRequest,
            provider: detail.provider,
            title: detail.title,
            body: detail.body,
          }),
          deleteBranch:
            detail.headSha !== undefined &&
            detail.headBranch !== detail.baseBranch &&
            detail.capabilities.deleteBranch === true,
        };
      }),
    );
    if (cleanup.worktree === null) return yield* skip("No unique delegated thread created this PR");

    const branch = yield* step(
      "delete remote head branch",
      { returns: Schema.String },
      cleanup.deleteBranch
        ? pullRequests
            .act(pullRequest, "delete-branch")
            .pipe(Effect.as("Head branch deleted or already absent."))
        : Effect.succeed("Host does not provide a safe branch deletion for this PR."),
    );

    const completed = [];
    for (const [index, url] of cleanup.issueUrls.entries()) {
      completed.push(
        yield* step(
          `complete issue ${index + 1}`,
          { returns: Schema.String },
          Effect.gen(function* () {
            const issue = { project: pullRequest.projectId, url };
            const detail = yield* issues.read(issue);
            const done = completionState(detail.states);
            if (done === undefined) return `${url} has no Done or completed state.`;
            if (detail.state.name !== done.name) yield* issues.setState(issue, done.name);
            return `${url} → ${done.name}`;
          }),
        ),
      );
    }
    return { worktree: cleanup.worktree, branch, issues: completed };
  }),
);
