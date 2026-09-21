import { useAtomValue } from "@effect/atom-react";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueListResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export interface IssueListAnswer {
  readonly target: IssueListTarget;
  readonly result: IssueListResult;
  readonly waiting: boolean;
}

export interface IssueListFailure {
  readonly target: IssueListTarget;
  readonly cause: Cause.Cause<unknown>;
}

interface IssueListsView {
  readonly answers: ReadonlyArray<IssueListAnswer>;
  readonly failures: ReadonlyArray<IssueListFailure>;
  readonly isPending: boolean;
}

const issueLists = Atom.family((key: string) =>
  Atom.make((get): IssueListsView => {
    const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
    const answers: IssueListAnswer[] = [];
    const failures: IssueListFailure[] = [];
    let isPending = false;
    for (const target of targets) {
      const result = get(issueEnvironment.list(target));
      isPending ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) answers.push({ target, result: value, waiting: result.waiting });
      if (result._tag === "Failure") failures.push({ target, cause: result.cause });
    }
    return { answers, failures, isPending };
  }).pipe(Atom.withLabel(`web-issues:lists:${key}`)),
);

const EMPTY_ISSUE_LISTS = Atom.make<IssueListsView>({
  answers: [],
  failures: [],
  isPending: false,
}).pipe(Atom.withLabel("web-issues:lists:empty"));

/** One guarded project query per target, observed through one hook-safe derived atom. */
export function useIssueLists(targets: ReadonlyArray<IssueListTarget>) {
  const key = JSON.stringify(targets);
  const view = useAtomValue(targets.length === 0 ? EMPTY_ISSUE_LISTS : issueLists(key));
  const refresh = useCallback(
    (override?: ReadonlyArray<IssueListTarget>) => {
      const refreshTargets = override ?? (JSON.parse(key) as ReadonlyArray<IssueListTarget>);
      for (const atom of new Set(refreshTargets.map(issueEnvironment.list))) {
        appAtomRegistry.refresh(atom);
      }
    },
    [key],
  );
  return { ...view, refresh };
}
