import {
  classifyIssueWorker,
  isIssueWorkerChild,
  issueWorkerStatus,
} from "@t3tools/shared/issueWorkerStatus";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { issuePullRequests } from "@t3tools/source-control-definitions/issuePullRequests";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { environmentCatalog } from "../connection/catalog";
import { useAtomValue } from "@effect/atom-react";
import { createRepositoryIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/repositoryIssues";
import type {
  EnvironmentId,
  RepositoryIssueListInput,
  RepositoryIssueListResult,
  IssueRepositoryRef,
  RepositoryIssueSummary,
  IssueRepositoriesResult,
  IssueStatusBatchInput,
  IssueStatusBatchResult,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAllEnvironmentShellsBootstrapped } from "./entities";
import { environmentThreadShells } from "./threads";
import { environmentServerConfigsAtom } from "./server";
import {
  allEnvironmentShellsBootstrappedAtom,
  environmentShell,
  environmentSnapshotAtom,
} from "./shell";
import { issueStatePresentation } from "../components/issues/IssueStateIcon";
import {
  createLiveIssueWorkOverlay,
  indexIssueWork,
} from "../components/issues/issueLiveWork.logic";

const removedThreadsFor = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(environmentShell.stateValueAtom(environmentId), (state) => state.removedAt),
);

const issueWorkIndexAtom = Atom.make((get) =>
  indexIssueWork(
    get(environmentThreadShells.threadShellsAtom),
    new Map(
      [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].map(
        (id) => [id, get(removedThreadsFor(id))] as const,
      ),
    ),
  ),
);

export const repositoryIssueEnvironment = createRepositoryIssueEnvironmentAtoms(
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
    const result = get(
      repositoryIssueEnvironment.statusBatch({ environmentId, input: { issues } }),
    );
    if (!AsyncResult.isSuccess(result)) return EMPTY_ISSUE_STATUSES;
    return new Map(result.value.map((issue) => [issueStatusKey(issue.host, issue.nodeId), issue]));
  }),
);

type SidebarIssueKey = Pick<ThreadLinkedIssue, "host" | "repository" | "nodeId" | "number">;
const issueStatusKey = (host: string, nodeId: string) =>
  JSON.stringify([host.toLowerCase(), nodeId]);
const sidebarIssueStatus = Atom.family((key: string) => {
  const [environmentId, host, nodeId] = JSON.parse(key) as [EnvironmentId, string, string];
  return Atom.map(sidebarIssueStatuses(environmentId), (statuses) =>
    statuses.get(issueStatusKey(host, nodeId)),
  );
});

/** Each row observes only its own presentation, including streamed work between GitHub refreshes. */
const sidebarIssuePresentation = Atom.family((key: string) => {
  const { environmentId, issue } = JSON.parse(key) as {
    environmentId: EnvironmentId;
    issue: SidebarIssueKey;
  };
  const statusAtom = sidebarIssueStatus(JSON.stringify([environmentId, issue.host, issue.nodeId]));
  const overlay = createLiveIssueWorkOverlay();
  return Atom.make((get) => {
    const status = get(statusAtom);
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
const UNKNOWN_ISSUE_STATUS = Atom.make(undefined);

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

export function useSidebarIssueWorkerStatus(thread: EnvironmentThreadShell, idle: boolean) {
  const issue = idle && isIssueWorkerChild(thread.source) ? thread.source.linkedIssue : undefined;
  const status = useAtomValue(
    issue === undefined
      ? UNKNOWN_ISSUE_STATUS
      : sidebarIssueStatus(JSON.stringify([thread.environmentId, issue.host, issue.nodeId])),
  );
  if (issue === undefined) return undefined;
  const links = visibleThreadPullRequests(thread.pullRequests);
  const workerStatus = issueWorkerStatus(
    { ...classifyIssueWorker(thread.source), pullRequests: links.map((pr) => pr.url) },
    { state: status?.state, pullRequests: issuePullRequests(status?.pullRequests ?? [], links) },
  );
  return status === undefined && workerStatus === "idle" ? null : workerStatus;
}

/** Apply streamed work after GitHub paging, whose freshness is keyed by fetchedAt. */
export function useLiveIssueWork() {
  const index = useAtomValue(issueWorkIndexAtom);
  const [overlay] = useState(createLiveIssueWorkOverlay);
  const ready = useAllEnvironmentShellsBootstrapped();
  return <T extends RepositoryIssueListResult>(list: T, environmentId: EnvironmentId): T =>
    ready ? overlay.list(list, environmentId, index) : list;
}

/** The durable Linked issue row uses the same shell overlay as repository issue rows. */
export function useLiveIssueSummary(
  issue: RepositoryIssueSummary | undefined,
  scope: IssueRepositoryRef,
  environmentId: EnvironmentId,
) {
  const index = useAtomValue(issueWorkIndexAtom);
  const ready = useAllEnvironmentShellsBootstrapped();
  const [overlay] = useState(createLiveIssueWorkOverlay);
  return !ready || issue === undefined
    ? issue
    : overlay.summary(issue, scope, environmentId, index);
}

export interface RepositoryIssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: RepositoryIssueListInput;
  /** A pane scoped to this one repository, which keeps its first page subscribed while paging. */
  readonly live?: boolean;
}

export interface IssueListAnswer {
  readonly target: RepositoryIssueListTarget;
  readonly result: RepositoryIssueListResult;
  readonly waiting: boolean;
}

export interface IssueListFailure {
  readonly target: RepositoryIssueListTarget;
  readonly cause: Cause.Cause<unknown>;
}

interface IssueListsView {
  readonly answers: ReadonlyArray<IssueListAnswer>;
  readonly failures: ReadonlyArray<IssueListFailure>;
  readonly isPending: boolean;
}

const issueListAtom = (target: RepositoryIssueListTarget) =>
  repositoryIssueEnvironment.list(target);

const issueLists = Atom.family((key: string) =>
  Atom.make((get): IssueListsView => {
    const targets = JSON.parse(key) as ReadonlyArray<RepositoryIssueListTarget>;
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
export function useIssueLists(targets: ReadonlyArray<RepositoryIssueListTarget>) {
  const key = JSON.stringify(targets);
  const view = useAtomValue(targets.length === 0 ? EMPTY_ISSUE_LISTS : issueLists(key));
  const refresh = (override?: ReadonlyArray<RepositoryIssueListTarget>) => {
    for (const atom of new Set((override ?? targets).map(issueListAtom))) {
      appAtomRegistry.refresh(atom);
    }
  };
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
      const result = get(repositoryIssueEnvironment.repositories({ environmentId, input: {} }));
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
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(
        repositoryIssueEnvironment.repositories({ environmentId, input: {} }),
      );
    }
  };
  return { ...view, refresh };
}
