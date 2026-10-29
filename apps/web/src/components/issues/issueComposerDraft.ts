import { IssueContextRecord } from "@t3tools/contracts";
import { Schema } from "effect";
import type { StoreApi } from "zustand";
import type {
  ComposerContextAddOptions,
  ComposerContextInsertionHandler,
  ComposerThreadDraftState,
  ComposerThreadTarget,
  ComposerDraftStoreState,
} from "../../composerDraftStore";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
} from "../../lib/composerContextReferences";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { issueContextReference } from "./issueComposerContext";

type Store = ComposerDraftStoreState;
const isIssueContextRecord = Schema.is(IssueContextRecord);
export interface IssueComposerDraftState {
  issueContexts: IssueContextRecord[];
}
export interface IssueComposerDraftActions {
  addIssueContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<IssueContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setIssueContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<IssueContextRecord>,
  ) => void;
}

type DraftData = { readonly issueContexts?: ReadonlyArray<IssueContextRecord> };
export const composerDraftExtension = {
  persistedFields: { issueContexts: Schema.optionalKey(Schema.Array(IssueContextRecord)) },
  empty: (): IssueComposerDraftState => ({ issueContexts: [] }),
  hasContent: (draft: DraftData) => (draft.issueContexts?.length ?? 0) > 0,
  normalize: (draft: { readonly issueContexts?: unknown }) => {
    const issueContexts = Array.isArray(draft.issueContexts)
      ? draft.issueContexts.filter(isIssueContextRecord)
      : [];
    return issueContexts.length > 0 ? { issueContexts } : {};
  },
  persist: (draft: DraftData) =>
    draft.issueContexts?.length
      ? {
          issueContexts: draft.issueContexts.map((record) => ({
            ...record,
            blockedBy: record.blockedBy.map((entry) => ({ ...entry })),
            liveWork: record.liveWork.map((entry) => ({ ...entry })),
            pullRequests: record.pullRequests.map((entry) => ({ ...entry })),
          })),
        }
      : {},
  hydrate: (draft: DraftData): IssueComposerDraftState => ({
    issueContexts: draft.issueContexts?.map((record) => ({ ...record })) ?? [],
  }),
  references: (draft: DraftData) => (draft.issueContexts ?? []).map(issueContextReference),
  move: (
    source: IssueComposerDraftState & { prompt: string },
    destination: IssueComposerDraftState,
  ) => {
    const issueContexts = [
      ...new Map(
        [...destination.issueContexts, ...source.issueContexts].map(
          (record) => [record.contextId, record] as const,
        ),
      ).values(),
    ];
    return {
      data: { issueContexts },
      prompt: replaceComposerContextReferences(source.prompt, (reference) =>
        reference.kind === "issue" ? source.prompt.slice(reference.start, reference.end) : "",
      ),
    };
  },
};

export function createIssueComposerDraftActions({
  set,
  get,
  resolveComposerDraftKey,
  createEmptyThreadDraft,
  shouldRemoveDraft,
  contextInsertionHandlers,
}: {
  set: StoreApi<Store>["setState"];
  get: () => Store;
  resolveComposerDraftKey: (state: Store, target: ComposerThreadTarget) => string | null;
  createEmptyThreadDraft: () => ComposerThreadDraftState;
  shouldRemoveDraft: (draft: ComposerThreadDraftState) => boolean;
  contextInsertionHandlers: Map<string, ComposerContextInsertionHandler>;
}): IssueComposerDraftActions {
  return {
    addIssueContexts: (threadRef, records, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const existingIds = new Set(
        (get().draftsByThreadKey[threadKey]?.issueContexts ?? []).map((record) => record.contextId),
      );
      const incoming = records.filter((record) => {
        if (existingIds.has(record.contextId)) return false;
        existingIds.add(record.contextId);
        return true;
      });
      if (incoming.length === 0) return;
      const references = incoming.map(issueContextReference);
      const placedAtCaret =
        options?.appendReference !== false &&
        options?.insertAtCaret !== false &&
        (contextInsertionHandlers.get(threadKey)?.(references) ?? false);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const known = new Set(existing.issueContexts.map((record) => record.contextId));
        const accepted = incoming.filter((record) => !known.has(record.contextId));
        if (accepted.length === 0) return state;
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt:
                placedAtCaret || options?.appendReference === false
                  ? existing.prompt
                  : ensureInlineContextReferences(
                      existing.prompt,
                      accepted.map(issueContextReference),
                    ),
              issueContexts: [...existing.issueContexts, ...accepted],
            },
          },
        };
      });
    },
    setIssueContexts: (threadRef, records) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const issueContexts = records.filter(isIssueContextRecord).map((record) => ({ ...record }));
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const retainedIds = new Set(issueContexts.map((record) => record.contextId));
        let prompt = existing.prompt;
        for (const previous of existing.issueContexts) {
          if (retainedIds.has(previous.contextId)) continue;
          prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
        }
        prompt = ensureInlineContextReferences(prompt, issueContexts.map(issueContextReference));
        const nextDraft = { ...existing, prompt, issueContexts };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
  };
}
