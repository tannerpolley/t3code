import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
import { useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { IssueListPanel } from "./IssueBrowser";
import { IssueDetailPanel } from "./IssueDetailPanel";

export function ThreadIssueSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "issue" | "issues" }>;
  readonly surfaces: readonly RightPanelSurface[];
}) {
  const { threadRef, surface } = props;
  const environmentId =
    surface.kind === "issue"
      ? ((surface.environmentId as EnvironmentId | undefined) ?? threadRef.environmentId)
      : threadRef.environmentId;
  const environment = useEnvironment(environmentId);
  const config = environment?.serverConfig ?? null;
  if (surface.kind === "issues") return <IssueListPanel threadRef={threadRef} />;
  if (
    environment === null ||
    (config === null &&
      ["available", "offline", "error", "unsupported"].includes(environment.connection.phase))
  ) {
    return (
      <PullRequestsUnavailableState
        title="Issues unavailable"
        error="Reconnect this environment to browse issues."
      />
    );
  }
  if (config === null) return <PullRequestDetailGhost />;
  if (config.environment.capabilities.githubIssues !== true) {
    return (
      <PullRequestsUnavailableState
        title="Issues unavailable"
        error="Update this environment's T3 Code server to browse issues."
      />
    );
  }
  const openList = props.surfaces.find((entry) => entry.kind === "issues");
  return (
    <IssueDetailPanel
      environmentId={environmentId}
      reference={{ host: surface.host, repository: surface.repository, number: surface.number }}
      threadRef={threadRef}
      onBack={() =>
        useRightPanelStore
          .getState()
          .openIssueList(
            threadRef,
            openList
              ? (openList.scope ?? null)
              : { host: surface.host, repository: surface.repository },
          )
      }
    />
  );
}
