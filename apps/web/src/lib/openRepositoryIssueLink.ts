import { threadIssueRepository } from "@t3tools/client-runtime/state/issue-work";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

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
  const match =
    /^\/([^/]+(?:\/[^/]+)+)\/-\/issues\/(\d+)\/?$/u.exec(url.pathname) ??
    /^\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/u.exec(url.pathname);
  if (match === null) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { host, repository: match[1]!, number };
}

/** github.com plus the host of every issue-capable project, Enterprise included. */
export function knownIssueHosts(
  projects: ReadonlyArray<Pick<EnvironmentProject, "repositoryIdentity">>,
): Set<string> {
  const hosts = new Set(["github.com"]);
  for (const project of projects) {
    const host = threadIssueRepository(project.repositoryIdentity)?.host;
    if (host) hosts.add(host.toLowerCase());
  }
  return hosts;
}
