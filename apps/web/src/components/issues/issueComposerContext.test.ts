import { describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger } from "@t3tools/shared/composerTrigger";
import {
  buildIssueReferenceContext,
  filterComposerIssues,
  issueContextMetadata,
} from "./issueComposerContext";

const issues = [
  { number: 12, title: "Fix the composer" },
  { number: 123, title: "Reference issues" },
  { number: 42, title: "Refine the picker" },
];
describe("composer issue matches", () => {
  it("uses the existing hash trigger, filters number prefixes and title text", () => {
    expect(detectComposerTrigger("Discuss #12", 11)).toMatchObject({
      kind: "pull-request",
      query: "12",
    });
    expect(filterComposerIssues(issues, "12").map((issue) => issue.number)).toEqual([12, 123]);
    expect(filterComposerIssues(issues, " REFERence ")).toEqual([issues[1]]);
    expect(filterComposerIssues(issues, "")).toEqual(issues);
    expect(filterComposerIssues(issues, "unmatched")).toEqual([]);
  });
  it("keeps identity distinct across repositories and carries a bounded metadata snapshot", () => {
    const metadata = issueContextMetadata({
      number: 12,
      title: "Fix the composer",
      url: "https://github.example.com/owner/repo/issues/12",
      state: "closed",
      stateReason: "duplicate",
    });
    expect(metadata).toMatchObject({
      host: "github.example.com",
      repository: "owner/repo",
      state: "closed",
      stateReason: "duplicate",
    });
    const record = buildIssueReferenceContext(metadata);
    expect(record.kind).toBe("issue");
    expect(record.contextId).not.toBe(
      buildIssueReferenceContext({
        ...metadata,
        repository: "other/repo",
        url: "https://github.example.com/other/repo/issues/12",
      }).contextId,
    );
  });
});
