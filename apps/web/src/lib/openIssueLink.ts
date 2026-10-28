import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type MouseEvent, useCallback, useMemo } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

/**
 * An issue page, `https://<host>/<owner>/<repo>/issues/<n>`, on one of `issueHosts`, or
 * null. The host must match exactly, including its port: a lookalike such as
 * `github.com.example.net` must stay an ordinary link.
 */
export function parseIssueUrl(
  value: string,
  issueHosts: ReadonlySet<string>,
): { readonly host: string; readonly repository: string; readonly number: number } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!issueHosts.has(host)) return null;
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u.exec(url.pathname);
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { host, repository: `${match[1]}/${match[2]}`, number };
}

/** github.com plus the host of every GitHub or Forgejo project, Enterprise included. */
export function knownIssueHosts(projects: ReadonlyArray<EnvironmentProject>): Set<string> {
  const hosts = new Set(["github.com"]);
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    // The canonical key starts with the remote's host, as the change request matcher reads it.
    if (identity?.provider === "github" || identity?.provider === "forgejo")
      hosts.add(identity.canonicalKey.split("/")[0]!.toLowerCase());
  }
  return hosts;
}

/**
 * Opens an issue link in T3's issue detail and says whether it did: beside the thread when
 * there is one, else on the Issues page. A modifier click, or no environment that reads GitHub
 * issues, leaves it an ordinary link.
 */
export function useOpenIssueLink(threadRef?: ScopedThreadRef) {
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const issueHosts = useMemo(() => knownIssueHosts(projects), [projects]);
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
      const issue = parseIssueUrl(url, issueHosts);
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
    [issueHosts, navigate, primaryEnvironmentId, serverConfigs, threadRef],
  );
}
