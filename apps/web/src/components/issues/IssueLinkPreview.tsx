import type { EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactElement } from "react";

import { knownGitHubHosts, parseIssueUrl } from "~/lib/openIssueLink";
import { useProjects, useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssueHoverCardContent } from "./IssueHoverCard";

export function useIssuePreviewTarget(
  environmentId: EnvironmentId | null | undefined,
  url: string,
) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const primary = usePrimaryEnvironmentId();
  const input = parseIssueUrl(url, knownGitHubHosts(projects));
  // A chat's environment owns its credentials; do not silently read through another account.
  const candidates = environmentId == null ? [primary, ...configs.keys()] : [environmentId];
  const target = candidates.find(
    (id) => id != null && configs.get(id)?.environment.capabilities.githubIssues === true,
  );
  return input === null || target == null ? null : { environmentId: target, input };
}

/** Ambiguous /issues/N links keep upstream's PR check, then preview the issue on failure. */
export function IssueLinkPreviewFallback({
  environmentId,
  url,
}: {
  environmentId: EnvironmentId | null;
  url: string;
}) {
  const target = useIssuePreviewTarget(environmentId, url);
  return target === null ? <span>{url}</span> : <IssueHoverCardContent target={target} />;
}

export function IssueLinkPreview({
  link,
  url,
  environmentId,
  title,
}: {
  readonly link: ReactElement;
  readonly url: string;
  readonly environmentId?: EnvironmentId | null;
  readonly title?: string;
}) {
  const target = useIssuePreviewTarget(environmentId, url);
  const [open, setOpen] = useState(false);
  if (target === null)
    return (
      <Tooltip>
        <TooltipTrigger render={link} />
        <TooltipPopup side="top">{url}</TooltipPopup>
      </Tooltip>
    );
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger render={link} delay={350} closeDelay={120} />
      <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="px-2 py-1">
          {open ? <IssueHoverCardContent target={target} title={title} /> : null}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
