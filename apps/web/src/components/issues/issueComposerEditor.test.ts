import { expect, it, vi } from "vite-plus/test";
import { buildIssueReferenceContext, issueContextMetadata } from "./issueComposerContext";
import {
  insertIssueComposerReference,
  reconcileIssueComposerReferences,
  selectIssueComposerReference,
} from "./issueComposerEditor";

const issue = issueContextMetadata({
  number: 42,
  title: "Fix login",
  url: "https://github.com/owner/repo/issues/42",
});

it("attaches only after a successful insertion and rejects stale menu selections", () => {
  const attach = vi.fn();
  const clearHighlight = vi.fn();
  const applyPromptReplacement = vi.fn(() => false);
  const input = {
    item: { id: "issue-42", issue },
    trigger: { kind: "pull-request", rangeStart: 4, rangeEnd: 7 },
    prompt: "See #42 ",
    items: [{ id: "issue-42" }],
    applyPromptReplacement,
    attach,
    clearHighlight,
  };
  selectIssueComposerReference({ ...input, items: [] });
  selectIssueComposerReference({ ...input, trigger: { ...input.trigger, kind: "path" } });
  expect(applyPromptReplacement).not.toHaveBeenCalled();
  selectIssueComposerReference(input);
  expect(attach).not.toHaveBeenCalled();
  expect(clearHighlight).not.toHaveBeenCalled();
  applyPromptReplacement.mockReturnValue(true);
  selectIssueComposerReference(input);
  const record = buildIssueReferenceContext(issue);
  expect(applyPromptReplacement).toHaveBeenLastCalledWith(
    4,
    8,
    `[${record.label}](t3-context://v1/issue/${record.contextId}) `,
    { expectedText: "#42 " },
  );
  expect(attach).toHaveBeenCalledExactlyOnceWith(record);
  expect(clearHighlight).toHaveBeenCalledOnce();
  attach.mockClear();
  expect(insertIssueComposerReference(issue, () => false, attach)).toBe(false);
  expect(attach).not.toHaveBeenCalled();
  expect(insertIssueComposerReference(issue, () => true, attach)).toBe(true);
  expect(attach).toHaveBeenCalledExactlyOnceWith(record);
});

it("retains removed issue payloads for undo without writing unchanged contexts", () => {
  const record = buildIssueReferenceContext(issue);
  const retained = new Map();
  const write = vi.fn();
  reconcileIssueComposerReferences([record], new Set([record.contextId]), retained, write);
  expect(write).not.toHaveBeenCalled();
  reconcileIssueComposerReferences([record], new Set(), retained, write);
  expect(write).toHaveBeenLastCalledWith([]);
  reconcileIssueComposerReferences([], new Set([record.contextId, "unknown"]), retained, write);
  expect(write).toHaveBeenLastCalledWith([record]);
});
