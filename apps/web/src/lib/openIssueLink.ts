import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

/**
 * A GitHub issue page, `https://<host>/<owner>/<repo>/issues/<n>`, or null. Only GitHub hosts
 * (github.com and Enterprise hosts named for it), since Gitea and Forgejo use the same path.
 */
export function parseIssueUrl(
  value: string,
): { readonly host: string; readonly repository: string; readonly number: number } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (host !== "github.com" && !host.split(".").includes("github")) return null;
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u.exec(url.pathname);
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { host, repository: `${match[1]}/${match[2]}`, number };
}

/**
 * Opens a GitHub issue link in T3's issue detail and says whether it did: beside the thread when
 * there is one, else on the Issues page. A modifier click, or no environment that reads GitHub
 * issues, leaves it an ordinary link.
 */
export function useOpenIssueLink(threadRef?: ScopedThreadRef) {
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (
      event: Pick<
        MouseEvent<HTMLElement>,
        "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
      >,
      url: string,
      environmentId?: EnvironmentId,
    ): boolean => {
      if (event.metaKey || event.ctrlKey) return false;
      const issue = parseIssueUrl(url);
      if (issue === null) return false;
      const readsIssues = (id: EnvironmentId | null | undefined): id is EnvironmentId =>
        id != null && serverConfigs.get(id)?.environment.capabilities.githubIssues === true;
      if (threadRef) {
        if (!readsIssues(threadRef.environmentId)) return false;
        event.preventDefault();
        event.stopPropagation();
        useRightPanelStore
          .getState()
          .openIssue(threadRef, { environmentId: threadRef.environmentId, ...issue, url });
        return true;
      }
      const target = [environmentId, primaryEnvironmentId, ...serverConfigs.keys()].find(
        readsIssues,
      );
      if (target === undefined) return false;
      event.preventDefault();
      event.stopPropagation();
      void navigate({
        to: "/issues",
        search: {
          selectedEnvironmentId: target,
          selectedHost: issue.host,
          selectedRepository: issue.repository,
          selectedNumber: issue.number,
        },
      });
      return true;
    },
    [navigate, primaryEnvironmentId, serverConfigs, threadRef],
  );
}
