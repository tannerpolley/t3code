export const githubRepository = (remote: string) => {
  const repository =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w-]+\/[\w.-]+)$/i
      .exec(remote)?.[1]
      ?.replace(/\.git$/i, "");
  if (!repository) throw new Error("Expected exactly one GitHub origin URL");
  return repository.toLowerCase();
};

export const issueNumber = (url: string, repository: string) => {
  const prefix = `https://github.com/${repository}/issues/`;
  const number = url.toLowerCase().startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[1-9]\d*$/.test(number)) throw new Error("Issue is outside the configured repository");
  return number;
};

export const hasHold = (labels: ReadonlyArray<{ readonly name: string }>) =>
  labels.some(({ name }) => ["needs you", "needs orchestrator"].includes(name.toLowerCase()));

export const eligible = (status: string | undefined, labels: Parameters<typeof hasHold>[0]) =>
  status === "Todo" && !hasHold(labels);

export const admissionKey = (url: string, previous?: { id: string; status: string }) => {
  if (previous && previous.status !== "skipped") return undefined;
  return `${url}/${previous?.id ?? "initial"}`;
};

export const claimDecision = (
  status: string,
  labels: Parameters<typeof hasHold>[0],
  runId: string,
  claim?: { runId: string; applied: boolean },
) => {
  if (hasHold(labels)) return "skip";
  if (status === "Todo") return "claim";
  if (status !== "In progress" || claim?.runId !== runId) return "skip";
  return claim.applied ? "resume" : "uncertain";
};

type PullRequest = {
  id: string;
  state: string;
  baseRefName: string;
  headRefOid: string;
  isInMergeQueue: boolean;
  isMergeQueueEnabled: boolean;
};
type Target = { head: string; base: string };
type MergeMethod = "SQUASH" | "REBASE" | "MERGE";
export type MergePolicy = {
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
};

export function verifyReviewedTarget(pr: PullRequest, { head, base }: Target) {
  if (pr.headRefOid !== head) throw new Error("PR head changed after review");
  if (pr.baseRefName !== base) throw new Error("PR target branch changed after review");
}

export async function submitReviewed(
  read: () => Promise<{ pr: PullRequest; status: string | null; policy: MergePolicy }>,
  submit: (id: string, head: string, method: MergeMethod | "QUEUE") => Promise<unknown>,
  target: Target,
) {
  const { pr, status, policy } = await read();
  verifyReviewedTarget(pr, target);
  if (pr.state !== "OPEN" && pr.state !== "MERGED") throw new Error("PR is no longer open");
  if (status !== "SUCCESS") throw new Error(`CI on ${target.head} is ${status ?? "absent"}`);
  if (pr.state === "MERGED") return "merged";
  if (pr.isInMergeQueue) return "queued";
  if (pr.isMergeQueueEnabled) {
    await submit(pr.id, target.head, "QUEUE");
    return "queued";
  }

  const method = policy.squashMergeAllowed
    ? "SQUASH"
    : policy.rebaseMergeAllowed
      ? "REBASE"
      : policy.mergeCommitAllowed
        ? "MERGE"
        : undefined;
  if (!method) throw new Error("GitHub repository enables no merge method");
  await submit(pr.id, target.head, method);
  return "submitted";
}

export function verifyReviewedMerge(pr: PullRequest, target: Target) {
  verifyReviewedTarget(pr, target);
  if (pr.state !== "MERGED") throw new Error("Merge at the reviewed head could not be verified");
}
