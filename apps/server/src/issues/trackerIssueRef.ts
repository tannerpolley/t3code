import {
  IssueReadError,
  type GitHubIssueStatus,
  type IssueError,
  type IssueRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TrackerIssueService from "../issue/IssueService.ts";

const readError = (
  operation: IssueReadError["operation"],
  code: IssueReadError["code"],
  message: string,
  retryAt?: number,
) =>
  new IssueReadError({
    code,
    operation,
    message,
    ...(retryAt === undefined ? {} : { retryAt }),
  });

export const fromTrackerError =
  (operation: IssueReadError["operation"]) =>
  (error: IssueError): IssueReadError => {
    if (error._tag === "IssueUnavailableError")
      return readError(
        operation,
        error.reason === "tool-missing"
          ? "missing-tool"
          : error.reason === "unauthenticated"
            ? "unauthenticated"
            : "unsupported",
        error.message,
      );
    return readError(
      operation,
      error.reason === "rate-limited"
        ? "rate-limited"
        : error.reason === "not-found"
          ? "inaccessible"
          : "upstream",
      error.detail,
      error.retryAt,
    );
  };

/**
 * Upstream's reference to a GitHub issue, through the project whose repository it is. Upstream
 * serves only a project's own repository, so one without a project has no issues here.
 */
export const trackerIssueRef = Effect.fn("trackerIssueRef")(function* (
  tracker: TrackerIssueService.IssueService["Service"],
  operation: IssueReadError["operation"],
  issue: { readonly host: string; readonly repository: string; readonly number?: number },
) {
  const ref = yield* tracker
    .resolveUrl(`https://${issue.host}/${issue.repository}/issues/${issue.number ?? 1}`)
    .pipe(Effect.mapError(fromTrackerError(operation)));
  if (!ref.writable)
    return yield* readError(
      operation,
      "scope-unavailable",
      "Add this repository as a project to use its issues.",
    );
  return {
    projectId: ref.projectId,
    tracker: ref.tracker,
    host: ref.host,
    scope: ref.scope,
    key: ref.key,
  } satisfies IssueRef;
});

export const setGitHubIssueStatus = Effect.fn("setGitHubIssueStatus")(function* (
  tracker: TrackerIssueService.IssueService["Service"],
  issue: { readonly host: string; readonly repository: string; readonly number: number },
  state: GitHubIssueStatus,
) {
  const ref = yield* trackerIssueRef(tracker, "detail", issue);
  yield* tracker.setState({ ...ref, state }).pipe(Effect.mapError(fromTrackerError("detail")));
});
