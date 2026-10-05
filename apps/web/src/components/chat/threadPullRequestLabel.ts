import type { RepositoryIdentity } from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

/**
 * How the thread details card names a pull request: `#N` when it belongs to the thread's own
 * repository (or the fork it pushes from), `owner/repo#N` when it belongs to another one, so a
 * linked pull request elsewhere doesn't read as the project's own.
 */
export function threadPullRequestLabel(
  pullRequest: { readonly repository?: string | undefined; readonly number: number },
  threadRepository: RepositoryIdentity | null | undefined,
): string {
  const own = [
    sourceControlRepositorySelector(threadRepository),
    threadRepository?.originRepository,
  ]
    .filter((repository) => typeof repository === "string")
    .map((repository) => repository.toLowerCase());
  return pullRequest.repository === undefined ||
    own.length === 0 ||
    own.includes(pullRequest.repository.toLowerCase())
    ? `#${pullRequest.number}`
    : `${pullRequest.repository}#${pullRequest.number}`;
}
