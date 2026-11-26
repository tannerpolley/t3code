import type { IssueState } from "../../packages/contracts/src/issue.ts";

export function completionState(states: ReadonlyArray<IssueState>) {
  const closed = states.filter((state) => state.category === "closed");
  return (
    closed.find((state) => state.name.toLowerCase() === "done") ??
    closed.find((state) => state.closeReason === "completed") ??
    (closed.length === 1 && closed[0]?.closeReason === undefined ? closed[0] : undefined)
  );
}

export function namedIssues(input: {
  readonly provider: string;
  readonly host: string;
  readonly repository: string;
  readonly title: string;
  readonly body: string;
}) {
  if (!["github", "gitlab", "forgejo"].includes(input.provider)) return [];
  const suffix = input.provider === "gitlab" ? "/-/issues/" : "/issues/";
  const root = `https://${input.host}`;
  const urls = new Set<string>();
  const text = `${input.title}\n${input.body}`.replace(
    /\x60{3}[\s\S]*?\x60{3}|\x60[^\x60\n]*\x60|<!--[\s\S]*?-->/g,
    "",
  );
  for (const match of text.matchAll(
    /https:\/\/([^/\s]+)\/((?:[\w.-]+\/)+?[\w.-]+)(\/-\/issues\/|\/issues\/)(\d+)\b|(?<![\w/#])(?:((?:[\w.-]+\/)+[\w.-]+))?#(\d+)\b/g,
  )) {
    if (
      match[1] !== undefined &&
      (match[1].toLowerCase() !== input.host.toLowerCase() || match[3] !== suffix)
    )
      continue;
    const repository = match[2] ?? match[5] ?? input.repository;
    urls.add(`${root}/${repository.toLowerCase()}${suffix}${match[4] ?? match[6]}`);
  }
  return [...urls];
}
