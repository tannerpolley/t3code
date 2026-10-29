import type { IssueContextMetadata, IssueContextRecord } from "@t3tools/contracts";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { extendReplacementRangeForTrailingSpace } from "../../composer-logic";
import { buildIssueReferenceContext, issueContextReference } from "./issueComposerContext";

export function reconcileIssueComposerReferences(
  composerIssueContexts: ReadonlyArray<IssueContextRecord>,
  referenced: ReadonlySet<string>,
  retainedIssues: Map<string, IssueContextRecord>,
  write: (records: IssueContextRecord[]) => void,
) {
  const liveIssueIds = new Set<string>(composerIssueContexts.map((record) => record.contextId));
  const restoredIssues = [...referenced].flatMap((contextId) => {
    if (liveIssueIds.has(contextId)) return [];
    const record = retainedIssues.get(contextId);
    return record ? [record] : [];
  });
  const nextIssues = [
    ...composerIssueContexts.filter((record) => referenced.has(record.contextId)),
    ...restoredIssues,
  ];
  for (const record of composerIssueContexts) {
    if (!referenced.has(record.contextId)) retainedIssues.set(record.contextId, record);
  }
  if (nextIssues.length !== composerIssueContexts.length || restoredIssues.length > 0) {
    write(nextIssues);
  }
}

export function insertIssueComposerReference(
  issue: IssueContextMetadata,
  insert: (text: string) => boolean,
  attach: (record: IssueContextRecord) => void,
) {
  const record = buildIssueReferenceContext(issue);
  const inserted = insert(`${formatInlineContextReference(issueContextReference(record))} `);
  if (inserted) attach(record);
  return inserted;
}

export function selectIssueComposerReference({
  item,
  trigger,
  prompt,
  items,
  applyPromptReplacement,
  attach,
  clearHighlight,
}: {
  item: { id: string; issue: IssueContextMetadata };
  trigger: { kind: string; rangeStart: number; rangeEnd: number };
  prompt: string;
  items: ReadonlyArray<{ id: string }>;
  applyPromptReplacement: (
    start: number,
    end: number,
    text: string,
    options: { expectedText: string },
  ) => boolean;
  attach: (record: IssueContextRecord) => void;
  clearHighlight: () => void;
}) {
  if (trigger.kind !== "pull-request" || !items.some((candidate) => candidate.id === item.id)) {
    return;
  }
  const record = buildIssueReferenceContext(item.issue);
  const replacement = `${formatInlineContextReference(issueContextReference(record))} `;
  const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
    prompt,
    trigger.rangeEnd,
    replacement,
  );
  const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
    expectedText: prompt.slice(trigger.rangeStart, replacementRangeEnd),
  });
  if (applied) {
    attach(record);
    clearHighlight();
  }
}
