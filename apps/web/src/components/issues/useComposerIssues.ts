import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, IssueListResult, IssueRepositoryRef } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { issueEnvironment, useLiveIssueWork } from "~/state/issues";
import { useServerConfigs } from "~/state/entities";
import { useIssueQueue } from "./IssueQueueAction";
import { filterComposerIssues, issueContextMetadata } from "./issueComposerContext";

const repositoryIssues = Atom.family((key: string) =>
  Atom.make((get) => {
    const { environmentId, scope } = JSON.parse(key) as {
      environmentId: EnvironmentId;
      scope: IssueRepositoryRef;
    };
    const pages: IssueListResult[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined;
    let waiting = false;
    do {
      const result = get(
        issueEnvironment.list({
          environmentId,
          input: {
            ...scope,
            state: "all",
            roadmap: true,
            ...(cursor === undefined ? {} : { cursor }),
          },
        }),
      );
      waiting ||= result.waiting;
      const page = Option.getOrNull(AsyncResult.value(result));
      if (page === null) break;
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined || visited.has(cursor)) break;
      visited.add(cursor);
    } while (cursor !== undefined);
    return { pages, waiting };
  }),
);
const emptyIssues = Atom.make<{ pages: IssueListResult[]; waiting: boolean }>({
  pages: [],
  waiting: false,
});

export function useComposerIssues(
  environmentId: EnvironmentId,
  scope: IssueRepositoryRef | null,
  query: string | null,
) {
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const supportsIssueContexts = capabilities?.issueContexts === true;
  const supported = supportsIssueContexts && capabilities?.githubIssues === true;
  const result = useAtomValue(
    scope !== null && query !== null && supported
      ? repositoryIssues(JSON.stringify({ environmentId, scope }))
      : emptyIssues,
  );
  const liveWork = useLiveIssueWork();
  const queue = useIssueQueue(environmentId, query === null ? null : scope);
  const issues = [
    ...new Map(
      result.pages
        .flatMap((page) => liveWork(page, environmentId).issues)
        .map((issue) => [issue.number, issue]),
    ).values(),
  ];
  return {
    supportsIssueContexts,
    issues: filterComposerIssues(issues, query ?? "")
      .slice(0, 20)
      .map(issueContextMetadata),
    // Kept beside the metadata: messages save that metadata, and queue state would go stale there.
    queuedNumbers: new Set(queue.data?.queue?.map((entry) => entry.issue.number)),
    isPending: result.waiting,
  };
}
