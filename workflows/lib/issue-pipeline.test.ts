import { describe, expect, it, vi } from "vite-plus/test";

import {
  admissionKey,
  eligible,
  githubRepository,
  issueNumber,
  mergeReviewed,
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
  it.each([null, "FAILURE", "PENDING"])("blocks a merge when CI reports %s", async (status) => {
    const merge = vi.fn();
    await expect(
      mergeReviewed(
        async () => ({ state: "OPEN", headRefOid: "reviewed" }),
        async () => status,
        merge,
        "reviewed",
      ),
    ).rejects.toThrow("CI");
    expect(merge).not.toHaveBeenCalled();
  });

  it("rejects a PR whose head moved even when CI is green", async () => {
    const merge = vi.fn();
    await expect(
      mergeReviewed(
        async () => ({ state: "OPEN", headRefOid: "new" }),
        async () => "SUCCESS",
        merge,
        "reviewed",
      ),
    ).rejects.toThrow("head changed");
    expect(merge).not.toHaveBeenCalled();
  });

  it("passes the reviewed head to merge, verifies it, and does not merge again on retry", async () => {
    let state = "OPEN";
    const merge = vi.fn(async () => {
      state = "MERGED";
    });
    const read = async () => ({ state, headRefOid: "reviewed" });
    const check = async () => "SUCCESS";

    await mergeReviewed(read, check, merge, "reviewed");
    await mergeReviewed(read, check, merge, "reviewed");
    expect(merge.mock.calls).toEqual([["reviewed"]]);
  });
});
