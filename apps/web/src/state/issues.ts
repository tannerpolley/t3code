import { useAtomValue } from "@effect/atom-react";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueListInput,
  IssueListResult,
  IssueRepositoriesResult,
} from "@t3tools/contracts";
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

export interface IssueRepositoriesAnswer {
  readonly environmentId: EnvironmentId;
  readonly result: IssueRepositoriesResult;
}

export interface IssueRepositoriesFailure {
  readonly environmentId: EnvironmentId;
  readonly cause: Cause.Cause<unknown>;
}

interface IssueRepositoriesView {
  readonly answers: ReadonlyArray<IssueRepositoriesAnswer>;
  readonly failures: ReadonlyArray<IssueRepositoriesFailure>;
  readonly isPending: boolean;
}

const issueRepositories = Atom.family((key: string) =>
  Atom.make((get): IssueRepositoriesView => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    const answers: IssueRepositoriesAnswer[] = [];
    const failures: IssueRepositoriesFailure[] = [];
    let isPending = false;
    for (const environmentId of environmentIds) {
      const result = get(issueEnvironment.repositories({ environmentId, input: {} }));
      isPending ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) answers.push({ environmentId, result: value });
      if (result._tag === "Failure") failures.push({ environmentId, cause: result.cause });
    }
    return { answers, failures, isPending };
  }).pipe(Atom.withLabel(`web-issues:repositories:${key}`)),
);

const EMPTY_ISSUE_REPOSITORIES = Atom.make<IssueRepositoriesView>({
  answers: [],
  failures: [],
  isPending: false,
}).pipe(Atom.withLabel("web-issues:repositories:empty"));

/** The repositories each environment's GitHub account owns or administers. */
export function useIssueRepositories(environmentIds: ReadonlyArray<EnvironmentId>) {
  const key = JSON.stringify(environmentIds);
  const view = useAtomValue(
    environmentIds.length === 0 ? EMPTY_ISSUE_REPOSITORIES : issueRepositories(key),
  );
  const refresh = useCallback(() => {
    for (const environmentId of JSON.parse(key) as ReadonlyArray<EnvironmentId>) {
      appAtomRegistry.refresh(issueEnvironment.repositories({ environmentId, input: {} }));
    }
  }, [key]);
  return { ...view, refresh };
}
