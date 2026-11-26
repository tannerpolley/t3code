import {
  continueIssuePage,
  holdIssuePages,
  issueCursorsForHost,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { issueTrackerDetailText } from "@t3tools/client-runtime/state/issue-trackers";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  IssueTrackerKind,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { issueEnvironment, type repoIssueBoardBinding, useIssueList } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { Button } from "../ui/button";
import { IssueBoard } from "./IssueBoard";
import { IssueRow, type IssueRowTarget } from "./IssueRow";

export function RepoIssueBoard({
  threadRef,
  projectId,
  binding,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  binding: NonNullable<ReturnType<typeof repoIssueBoardBinding>>;
}) {
  const { environmentId } = threadRef;
  const { host, scope } = binding;
  const tracker = IssueTrackerKind.make(binding.tracker);
  const gt = useGT();
  const resolve = useMessages();
  const input = { projectId, host, scope, state: "all", limit: 50 } as const;
  const list = useIssueList([{ environmentId, input }]);
  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(new Map());
  const page = holdIssuePages(list.answers, pages).get(environmentId);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const cursors = page === undefined ? {} : issueCursorsForHost(page.nextCursors, host);
  const hasMore = Object.keys(cursors).length > 0;
  const loadMore = async () => {
    if (page === undefined || !hasMore || loadingMore) return;
    setLoadingMore(true);
    const result = await loadPage({ environmentId, input: { ...input, cursors } });
    setLoadingMore(false);
    const next =
      result._tag === "Failure"
        ? { failure: String(squashAtomCommandFailure(result)) }
        : result.value;
    setPages(new Map([[environmentId, continueIssuePage(page, next, cursors)]]));
  };
  const selectEntry = (entry: IssueRowTarget) => {
    useRightPanelStore.getState().openIssue(threadRef, entry);
  };

  const rows =
    page?.entries
      .filter(
        (row) =>
          row.projectId === projectId &&
          row.tracker === tracker &&
          row.host.toLowerCase() === host.toLowerCase() &&
          row.scope.toLowerCase() === scope.toLowerCase(),
      )
      .map((row) => ({ ...row, environmentId })) ?? [];
  const summary = page?.answer.trackers.find(
    (item) => item.host === host && item.tracker === tracker,
  );
  const trackerError =
    summary?.configured === false
      ? summary.detail === null
        ? gt("This tracker cannot be read right now.")
        : issueTrackerDetailText(summary.detail, resolve)
      : null;
  const error = list.error ?? page?.moreFailure ?? trackerError;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto border-t py-2">
      {page === undefined && list.isPending ? <PullRequestListGhost rows={3} /> : null}
      {error !== null ? (
        <PullRequestsUnavailableState
          title={gt("Issues unavailable")}
          error={error}
          onRetry={page?.moreFailure === error ? () => void loadMore() : list.refresh}
          refreshing={list.isPending || loadingMore}
        />
      ) : null}
      {page && page.errors.length > 0 ? (
        <p className="px-3 text-xs whitespace-pre-line text-destructive">
          {page.errors.map(({ projectTitle, message }) => `${projectTitle}: ${message}`).join("\n")}
        </p>
      ) : null}
      {page !== undefined && rows.length === 0 && page.errors.length === 0 && error === null ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          <T>No issues under these filters.</T>
        </p>
      ) : null}
      <IssueBoard
        rows={rows}
        renderRow={(row) => (
          <IssueRow
            key={issueEntryKey(row)}
            entry={row}
            selected={false}
            wrapTitle
            showScope={false}
            showTracker={false}
            onSelect={selectEntry}
          />
        )}
      />
      {hasMore && page?.moreFailure === null ? (
        <div className="px-3">
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={loadingMore || list.isPending}
            onClick={() => void loadMore()}
          >
            {loadingMore ? <T>Loading…</T> : <T>Load more</T>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
