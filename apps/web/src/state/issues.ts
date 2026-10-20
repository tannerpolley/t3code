import { useAtomValue } from "@effect/atom-react";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueListInput,
  IssueListResult,
  IssueRepositoryRef,
  IssueSummary,
  IssueRepositoriesResult,
  IssueStatusBatchInput,
  IssueStatusBatchResult,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAllEnvironmentShellsBootstrapped } from "./entities";
import { environmentThreadShells } from "./threads";
import { environmentServerConfigsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom, environmentSnapshotAtom } from "./shell";
import { issueStatePresentation } from "../components/issues/IssueStateIcon";
import {
  createLiveIssueWorkOverlay,
  indexIssueWork,
} from "../components/issues/issueLiveWork.logic";

const issueWorkIndexAtom = Atom.make((get) =>
  indexIssueWork(get(environmentThreadShells.threadShellsAtom)),
);

export const issueEnvironment = createIssueEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);

const sidebarIssueRefs = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const refs = new Map<string, IssueStatusBatchInput["issues"][number]>();
    for (const thread of get(environmentThreadShells.environmentThreadsAtom(environmentId))) {
      const issue = thread.linkedIssue;
      if (issue === undefined || thread.archivedAt !== null) continue;
      const ref = { host: issue.host.toLowerCase(), nodeId: issue.nodeId };
      refs.set(JSON.stringify(ref), ref);
    }
    return JSON.stringify(
      [...refs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, ref]) => ref),
    );
  }),
);

const EMPTY_ISSUE_STATUSES: ReadonlyMap<string, IssueStatusBatchResult[number]> = new Map();
const sidebarIssueStatuses = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, IssueStatusBatchResult[number]> => {
    if (
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .issueStatusBatch !== true
    )
      return EMPTY_ISSUE_STATUSES;
    const issues = JSON.parse(
      get(sidebarIssueRefs(environmentId)),
    ) as IssueStatusBatchInput["issues"];
    if (issues.length === 0) return EMPTY_ISSUE_STATUSES;
    const result = get(issueEnvironment.statusBatch({ environmentId, input: { issues } }));
    if (!AsyncResult.isSuccess(result)) return EMPTY_ISSUE_STATUSES;
    return new Map(
      result.value.map((issue) => [
        JSON.stringify([issue.host.toLowerCase(), issue.nodeId]),
        issue,
      ]),
    );
  }),
);

/** Each row observes only its own presentation, including streamed work between GitHub refreshes. */
const sidebarIssuePresentation = Atom.family((key: string) => {
  const { environmentId, issue } = JSON.parse(key) as {
    environmentId: EnvironmentId;
    issue: Pick<ThreadLinkedIssue, "host" | "repository" | "nodeId" | "number">;
  };
  const overlay = createLiveIssueWorkOverlay();
  return Atom.make((get) => {
    const status = get(sidebarIssueStatuses(environmentId)).get(
      JSON.stringify([issue.host.toLowerCase(), issue.nodeId]),
    );
    if (status === undefined) return null;
    const summary = {
      ...status,
      number: issue.number,
      closingPullRequests: status.closingPullRequests ?? status.pullRequests,
    };
    return issueStatePresentation(
      get(allEnvironmentShellsBootstrappedAtom)
        ? overlay.summary(summary, issue, environmentId, get(issueWorkIndexAtom))
        : summary,
    );
  }).pipe(
    Atom.withEquality<ReturnType<typeof issueStatePresentation> | null>(
      (left, right) => left?.label === right?.label && left?.toneClassName === right?.toneClassName,
    ),
  );
});
const UNKNOWN_ISSUE_PRESENTATION = Atom.make(null);

export function useSidebarIssuePresentation(
  environmentId: EnvironmentId,
  issue: ThreadLinkedIssue | undefined,
) {
  return useAtomValue(
    issue === undefined
      ? UNKNOWN_ISSUE_PRESENTATION
      : sidebarIssuePresentation(
          JSON.stringify({
            environmentId,
            issue: {
              host: issue.host,
              repository: issue.repository,
              nodeId: issue.nodeId,
              number: issue.number,
            },
          }),
        ),
  );
}

/** Apply streamed work after GitHub paging, whose freshness is keyed by fetchedAt. */
export function useLiveIssueWork() {
  const index = useAtomValue(issueWorkIndexAtom);
  const overlay = useMemo(() => createLiveIssueWorkOverlay(), []);
  const ready = useAllEnvironmentShellsBootstrapped();
  return useCallback(
    <T extends IssueListResult>(list: T, environmentId: EnvironmentId): T => {
      if (!ready) return list;
      return overlay.list(list, environmentId, index);
    },
    [ready, index, overlay],
  );
}

/** The durable Linked issue row uses the same shell overlay as repository issue rows. */
export function useLiveIssueSummary(
  issue: IssueSummary | undefined,
  scope: IssueRepositoryRef,
  environmentId: EnvironmentId,
) {
  const index = useAtomValue(issueWorkIndexAtom);
  const ready = useAllEnvironmentShellsBootstrapped();
  const overlay = useMemo(() => createLiveIssueWorkOverlay(), []);
  return !ready || issue === undefined
    ? issue
    : overlay.summary(issue, scope, environmentId, index);
}

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
  /** The repository shows the Roadmap view, whose first page stays live. */
  readonly roadmapView?: boolean;
  /** A pane scoped to this one repository, whose first page stays live like a thread's list. */
  readonly live?: boolean;
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

// Only first pages are polled: the Roadmap's and a one-repository pane's.
// All pages also re-read when issue links change.
const issueListAtom = (target: IssueListTarget) =>
  (target.input.cursor !== undefined
    ? issueEnvironment.list
    : target.roadmapView
      ? issueEnvironment.roadmapList
      : target.live
        ? issueEnvironment.liveList
        : issueEnvironment.list)(target);

const issueLists = Atom.family((key: string) =>
  Atom.make((get): IssueListsView => {
    const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
    const answers: IssueListAnswer[] = [];
    const failures: IssueListFailure[] = [];
    let isPending = false;
    for (const target of targets) {
      const result = get(issueListAtom(target));
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
      const refreshTargets = override ?? targets;
      for (const atom of new Set(refreshTargets.map(issueListAtom))) {
        appAtomRegistry.refresh(atom);
      }
    },
    [targets],
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
