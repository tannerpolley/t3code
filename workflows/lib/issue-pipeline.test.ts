import { describe, expect, it, vi } from "vite-plus/test";

import {
  admissionKey,
  claimDecision,
  eligible,
  githubRepository,
  issueNumber,
  submitReviewed,
  verifyReviewedMerge,
} from "./issue-pipeline.ts";

describe("issue pipeline admission", () => {
  it("excludes holds case-insensitively and only admits Todo", () => {
    expect(eligible("Todo", [{ name: "enhancement" }])).toBe(true);
    expect(eligible("Todo", [{ name: "Needs YOU" }])).toBe(false);
    expect(eligible("Todo", [{ name: "Needs orchestrator" }])).toBe(false);
    expect(eligible("Backlog", [])).toBe(false);
  });

  it("deduplicates pending runs and allows a new attempt after a skipped admission", () => {
    const url = "https://github.com/acme/widgets/issues/3";
    expect(admissionKey(url)).toBe(url + "/initial");
    expect(admissionKey(url, { id: "one", status: "waiting" })).toBeUndefined();
    expect(admissionKey(url, { id: "one", status: "running" })).toBeUndefined();
    expect(admissionKey(url, { id: "one", status: "skipped" })).toBe(url + "/one");
  });

  it("rechecks holds and recognizes only the current run's confirmed claim", () => {
    const applied = { runId: "first", applied: true };
    expect(claimDecision("Backlog", [], "first", applied)).toBe("skip");
    expect(claimDecision("Todo", [{ name: "Needs you" }], "first", applied)).toBe("skip");
    expect(claimDecision("In progress", [{ name: "Needs orchestrator" }], "first", applied)).toBe(
      "skip",
    );
    expect(claimDecision("In progress", [], "later", applied)).toBe("skip");
    expect(claimDecision("In progress", [], "first", applied)).toBe("resume");
    expect(claimDecision("In progress", [], "first", { ...applied, applied: false })).toBe(
      "uncertain",
    );
    expect(claimDecision("Todo", [], "later", applied)).toBe("skip");
    expect(claimDecision("Todo", [], "later", { ...applied, applied: false })).toBe("skip");
    expect(claimDecision("Todo", [], "later")).toBe("claim");
  });

  it("rejects foreign issue URLs and multiple push destinations", () => {
    const repository = githubRepository("git@github.com:Owner/Repo.git");
    expect(issueNumber("https://github.com/Owner/Repo/issues/42", repository)).toBe("42");
    expect(() => issueNumber("https://github.com/owner/other/issues/42", repository)).toThrow();
    expect(() =>
      githubRepository("git@github.com:owner/repo.git\ngit@github.com:owner/other.git"),
    ).toThrow();
  });
});

describe("reviewed PR merge", () => {
  const target = { base: "main", head: "reviewed" };
  const opened = {
    id: "pull-request",
    state: "OPEN",
    baseRefName: target.base,
    headRefOid: target.head,
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
  };
  const policy = { squashMergeAllowed: true, rebaseMergeAllowed: true, mergeCommitAllowed: true };

  it("submits the reviewed head without a PR check result", async () => {
    const submit = vi.fn();
    await expect(
      submitReviewed(async () => ({ pr: opened, policy }), submit, target),
    ).resolves.toBe("submitted");
    expect(submit.mock.calls).toEqual([["pull-request", "reviewed", "SQUASH"]]);
  });

  it.each([
    [{ ...opened, headRefOid: "new" }, "head changed"],
    [{ ...opened, baseRefName: "release" }, "target branch changed"],
    [{ ...opened, baseRefName: "release", state: "MERGED" }, "target branch changed"],
  ] as const)("blocks publication and closeout after head or target drift", async (pr, message) => {
    const submit = vi.fn();
    await expect(submitReviewed(async () => ({ pr, policy }), submit, target)).rejects.toThrow(
      message,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(() => verifyReviewedMerge(pr, target)).toThrow(message);
  });

  it("uses an enabled merge method with the reviewed head and verifies the result", async () => {
    const submit = vi.fn();
    const allowed = { ...policy, squashMergeAllowed: false };
    const merged = { ...opened, state: "MERGED" };
    await expect(
      submitReviewed(async () => ({ pr: opened, policy: allowed }), submit, target),
    ).resolves.toBe("submitted");
    await expect(
      submitReviewed(async () => ({ pr: merged, policy: allowed }), submit, target),
    ).resolves.toBe("merged");
    expect(submit.mock.calls).toEqual([["pull-request", "reviewed", "REBASE"]]);
    expect(() => verifyReviewedMerge(merged, target)).not.toThrow();
  });

  it("enqueues at the reviewed head once and requires the PR to finish merging before closeout", async () => {
    const submit = vi.fn();
    const queueRequired = { ...opened, isMergeQueueEnabled: true };
    const queued = { ...queueRequired, isInMergeQueue: true };
    await expect(
      submitReviewed(async () => ({ pr: queueRequired, policy }), submit, target),
    ).resolves.toBe("queued");
    await expect(
      submitReviewed(async () => ({ pr: queued, policy }), submit, target),
    ).resolves.toBe("queued");
    expect(submit.mock.calls).toEqual([["pull-request", "reviewed", "QUEUE"]]);
    expect(() => verifyReviewedMerge(queued, target)).toThrow("could not be verified");
    expect(() => verifyReviewedMerge({ ...queued, state: "MERGED" }, target)).not.toThrow();
  });
});
