import { describe, expect, it } from "vite-plus/test";

import { issueBadges, issueStage } from "./issueStage.ts";

const blocker = (state: "open" | "closed") => ({ state });
const work = (
  status: "working" | "waiting_on_you" | "question" | "idle" | "queued" | "failed",
  extra: { inherited?: boolean; requestHandledByParent?: boolean } = {},
) => ({ status, ...extra });
const pr = (state: "open" | "merged" | "closed") => ({ state });

describe("issueStage", () => {
  it("puts each issue in exactly one pipeline stage, ignoring blockers and suspension", () => {
    expect(issueStage({ state: "open" })).toBe("backlog");
    expect(issueStage({ state: "open", liveWork: [work("idle")] })).toBe("backlog");
    expect(issueStage({ state: "open", pullRequests: [pr("merged")] })).toBe("backlog");
    expect(issueStage({ state: "open", pullRequests: [pr("closed")] })).toBe("backlog");
    expect(issueStage({ state: "open", pullRequests: [pr("open")] })).toBe("ready_for_review");
    expect(issueStage({ state: "open", queued: true })).toBe("queued");
    expect(issueStage({ state: "open", liveWork: [work("queued")] })).toBe("queued");
    expect(issueStage({ state: "open", liveWork: [work("working")] })).toBe("in_progress");
    expect(issueStage({ state: "open", liveWork: [work("waiting_on_you")] })).toBe("in_progress");
    // Only the directly linked thread drives running status; descendants waiting on the owner count.
    expect(issueStage({ state: "open", liveWork: [work("working", { inherited: true })] })).toBe(
      "backlog",
    );
    expect(issueStage({ state: "open", liveWork: [work("question", { inherited: true })] })).toBe(
      "in_progress",
    );
    // A live worker beats the queue and an open PR; the queue beats an open PR.
    expect(
      issueStage({
        state: "open",
        queued: true,
        pullRequests: [pr("open")],
        liveWork: [work("working")],
      }),
    ).toBe("in_progress");
    expect(issueStage({ state: "open", queued: true, pullRequests: [pr("open")] })).toBe("queued");
    // Blockers and suspension are badges now, never stages.
    expect(
      issueStage({ state: "open", blockedBy: [blocker("open")], liveWork: [work("working")] }),
    ).toBe("in_progress");
    expect(issueStage({ state: "open", blockedBy: [blocker("open")], queued: true })).toBe(
      "queued",
    );
    expect(
      issueStage({ state: "open", blockedBy: [blocker("open")], pullRequests: [pr("open")] }),
    ).toBe("ready_for_review");
    expect(
      issueStage({ state: "open", suspensionReason: "No access", liveWork: [work("working")] }),
    ).toBe("in_progress");
    expect(issueStage({ state: "open", relationshipsComplete: false })).toBe("backlog");
  });

  it("splits closed issues the way GitHub closes them, whatever their work says", () => {
    expect(issueStage({ state: "closed", stateReason: "completed" })).toBe("done");
    expect(issueStage({ state: "closed", stateReason: null, liveWork: [work("working")] })).toBe(
      "done",
    );
    expect(issueStage({ state: "closed", stateReason: "not_planned" })).toBe("closed");
    expect(issueStage({ state: "closed", stateReason: "duplicate" })).toBe("closed");
    expect(issueStage({ state: "open", stateReason: "reopened" })).toBe("backlog");
  });
});

describe("issueBadges", () => {
  it("demotes blocked, suspended, needs you and failed to badges in a fixed order", () => {
    expect(
      issueBadges({
        state: "open",
        relationshipsComplete: false,
        liveWork: [work("failed"), work("waiting_on_you")],
        suspensionReason: "No access",
        blockedBy: [blocker("closed"), blocker("open")],
      }),
    ).toEqual(["blocked", "suspended", "needs_you", "failed", "dependencies_unknown"]);
    expect(issueBadges({ state: "open", blockedBy: [blocker("closed")] })).toEqual([]);
    expect(issueBadges({ state: "open", liveWork: [work("working"), work("idle")] })).toEqual([]);
  });

  it("leaves a request its parent handles off Needs you, and closed issues bare", () => {
    expect(
      issueBadges({
        state: "open",
        liveWork: [work("question", { requestHandledByParent: true })],
      }),
    ).toEqual([]);
    expect(
      issueBadges({ state: "closed", blockedBy: [blocker("open")], liveWork: [work("failed")] }),
    ).toEqual([]);
  });
});
