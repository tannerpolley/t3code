import * as Effect from "effect/Effect";

import * as IssueForgejoHost from "./IssueForgejoHost.ts";
import * as IssueGitLabHost from "./IssueGitLabHost.ts";
import * as IssueGitHubHost from "./IssueGitHubHost.ts";
import { routeIssueHosts, type IssueHost, type IssueHostContext } from "./IssueHost.ts";

/**
 * Builds every issue host adapter. A new adapter claims its hosts here; capabilities and the
 * provider kinds that have Issues are declared once in contracts (`ISSUE_HOSTS`).
 */
export const make = Effect.fn("IssueHostRegistry.make")(function* (context: IssueHostContext) {
  const github = yield* IssueGitHubHost.make(context);
  const claimed = new Map<string, IssueHost>();
  for (const [host, adapter] of yield* IssueForgejoHost.discover(context))
    claimed.set(host, adapter);
  const nestedRepositoryHosts = new Set<string>();
  for (const [host, adapter] of yield* IssueGitLabHost.discover(context)) {
    if (claimed.has(host)) continue;
    claimed.set(host, adapter);
    nestedRepositoryHosts.add(host);
  }
  return { ...routeIssueHosts(github, claimed), nestedRepositoryHosts };
});
