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

export const eligible = (
  status: string | undefined,
  labels: ReadonlyArray<{ readonly name: string }>,
) =>
  status === "Todo" &&
  !labels.some(({ name }) => ["needs you", "needs orchestrator"].includes(name.toLowerCase()));

export const admissionKey = (url: string, previous?: { id: string; status: string }) => {
  if (previous && previous.status !== "skipped") return undefined;
  return `${url}/${previous?.id ?? "initial"}`;
};

export async function mergeReviewed(
  read: () => Promise<{ headRefOid: string; state: string }>,
  check: () => Promise<string | null>,
  merge: (head: string) => Promise<unknown>,
  head: string,
) {
  const current = await read();
  if (current.headRefOid !== head) throw new Error("PR head changed after review");
  if (current.state !== "OPEN" && current.state !== "MERGED")
    throw new Error("PR is no longer open");
  const status = await check();
  if (status !== "SUCCESS") throw new Error(`CI on ${head} is ${status ?? "absent"}`);
  if (current.state === "MERGED") return;
  await merge(head);
  const verified = await read();
  if (verified.state !== "MERGED" || verified.headRefOid !== head) {
    throw new Error("Merge at the reviewed head could not be verified");
  }
}
