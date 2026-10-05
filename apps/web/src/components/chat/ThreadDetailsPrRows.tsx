import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type { EnvironmentId, RepositoryIdentity, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { Minus, Plus } from "lucide";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import { findProjectOnChangeRequestHost, parseChangeRequestUrl } from "~/lib/openPullRequestLink";

import { useProjects } from "~/state/entities";

import { pullRequestListLines } from "../pullRequest/pullRequestListLines";
import { MorphIcon } from "~/components/MorphIcon";
import { linkedPullRequestSnapshotStatus, prStatusIndicator } from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import { threadPullRequestLabel } from "./threadPullRequestLabel";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  threadRepository,
  onOpen,
  onActed,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  threadRepository: RepositoryIdentity | null | undefined;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
}) {
  const projects = useProjects();
  const parsed = parseChangeRequestUrl(link.url);
  const project =
    parsed === null
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed,
        ) ?? null);
  const linked = linkedPullRequestSnapshotStatus(link);
  const pr = linked?.pr ?? null;
  const referenceLabel = threadPullRequestLabel(link, threadRepository);
  return (
    <ThreadDetailsPrRow
      environmentId={environmentId}
      pr={pr}
      number={link.number}
      reference={link}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      project={project}
      label={`${referenceLabel}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`}
      referenceLabel={referenceLabel}
      openAriaLabel={link.url}
      onOpen={onOpen}
      {...(onActed ? { onActed } : {})}
    />
  );
}

export function ThreadDetailsPrRows({
  links,
  currentLink,
  onOpenLink,
  ...row
}: ComponentProps<typeof ThreadDetailsPrRow> & {
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rest =
    currentLink === null
      ? []
      : pullRequestListLines(resolveThreadPullRequestChains(visibleThreadPullRequests(links)))
          .map((line) => line.link)
          .filter((link) => threadPullRequestKeyOf(link) !== threadPullRequestKeyOf(currentLink));
  if (rest.length === 0) return <ThreadDetailsPrRow {...row} />;

  return (
    <>
      <ThreadDetailsPrRow {...row} />
      {expanded
        ? rest.map((link) => (
            <ThreadDetailsPrLinkRow
              key={threadPullRequestKeyOf(link)}
              environmentId={row.environmentId}
              link={link}
              threadRepository={row.project?.repositoryIdentity}
              onOpen={(event) => onOpenLink(event, link.url)}
              onActed={row.onActed}
            />
          ))
        : null}
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        part="row"
        tone="muted"
        className="w-full active:scale-100"
      >
        <MorphIcon aria-hidden className="size-4 shrink-0" icon={expanded ? Minus : Plus} />
        {expanded ? "Show less" : `Show ${rest.length} more`}
      </ThreadDetailsControl>
    </>
  );
}
