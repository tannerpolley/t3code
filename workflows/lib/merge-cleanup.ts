import type { IssueState } from "../../packages/contracts/src/issue.ts";

export function completionState(states: ReadonlyArray<IssueState>) {
  const closed = states.filter((state) => state.category === "closed");
  return (
    closed.find((state) => state.name.toLowerCase() === "done") ??
    closed.find((state) => state.closeReason === "completed") ??
    (closed.length === 1 && closed[0]?.closeReason === undefined ? closed[0] : undefined)
  );
}

export function namedGitHubIssues(input: {
  readonly host: string;
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}) {
  const root = `https://${input.host}`;
  const urls = new Set<string>();
  const text = `${input.title}\n${input.body}`.replace(
    /\x60{3}[\s\S]*?\x60{3}|\x60[^\x60\n]*\x60|<!--[\s\S]*?-->/g,
    "",
  );
  for (const match of text.matchAll(
    /https:\/\/([^/\s]+)\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b|(?<![\w/#])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g,
  )) {
    if (match[1] !== undefined && match[1].toLowerCase() !== input.host.toLowerCase()) continue;
    const repository = match[2] ?? match[4] ?? input.repository;
    urls.add(`${root}/${repository.toLowerCase()}/issues/${match[3] ?? match[5]}`);
  }
  return [...urls];
}
