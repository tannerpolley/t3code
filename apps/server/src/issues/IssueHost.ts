import * as Effect from "effect/Effect";
import {
  IssueMilestone,
  IssueReadError,
  type IssueDetailInput as IssueDetailInputType,
  type IssueDetailResult as IssueDetailResultType,
  type IssueStatusBatchResult,
  type IssueListState,
  type IssueRepositoriesResult as IssueRepositoriesResultType,
  type IssueSummary as IssueSummaryType,
  type IssueWorkRead,
  type IssueChangeBaseline,
  type IssueRepositoryRef,
  type IssueRef,
  type ThreadLinkedIssue as ThreadLinkedIssueType,
} from "@t3tools/contracts";
export interface IssueRepositoryScope {
  readonly cwd: string;
  readonly host: string;
  readonly repository: string;
}

export interface PageResult<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextPage: number | null;
  readonly etag?: string | undefined;
  readonly fetchedAt?: string;
  readonly generation?: number;
}

export type ListMetadata = Map<
  number,
  Partial<
    Pick<
      IssueSummaryType,
      | "projects"
      | "parent"
      | "blockedBy"
      | "subIssues"
      | "relationshipsComplete"
      | "pullRequestRefs"
      | "pullRequests"
    >
  >
>;
export type PageResponse<A> =
  | PageResult<A>
  | {
      readonly notModified: true;
      readonly nextPage: number | null | undefined;
      readonly etag: string | undefined;
    };

export interface IssuePageResult extends PageResult<IssueSummaryType> {
  readonly metadata?: Partial<Record<"projects" | "roadmap", ListMetadata>> | undefined;
}

export interface IssueHostIdentity {
  readonly accountId: string;
  readonly viewer: string;
  readonly credentialFingerprint: string;
}
interface InboxActor {
  readonly login: string;
  readonly type?: string | undefined;
}
interface InboxIssue {
  readonly number: number;
  readonly title: string;
  readonly state?: "open" | "closed" | undefined;
  readonly body?: string | null | undefined;
  readonly user?: InboxActor | null | undefined;
  readonly labels?: ReadonlyArray<{ readonly name: string }> | null | undefined;
  readonly milestone?: { readonly number: number } | null | undefined;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
  readonly pull_request?: unknown | undefined;
}
interface InboxComment {
  readonly id: number;
  readonly body?: string | null | undefined;
  readonly user?: InboxActor | null | undefined;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
  readonly issue_url: string;
}
interface InboxEvent {
  readonly id: number;
  readonly event: string;
  readonly created_at: string;
  readonly issue?: { readonly number: number; readonly pull_request?: unknown } | null | undefined;
}
interface InboxPosted {
  readonly id: number;
  readonly number?: number | undefined;
  readonly html_url: string;
}
interface InboxListedComment {
  readonly id: number;
  readonly body: string | null;
  readonly html_url: string;
}
interface ActivityCursors {
  readonly issuesSince: string;
  readonly commentsSince: string;
  readonly eventsAfter: number;
  readonly issuesEtag: string | null;
  readonly commentsEtag: string | null;
  readonly eventsEtag: string | null;
  readonly initial?: boolean;
}
interface ActivityPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly etag: string | null;
  readonly complete: boolean;
}

export interface IssueHost {
  readonly readChangeState: (
    input: import("@t3tools/contracts").IssueRef,
  ) => Effect.Effect<IssueChangeBaseline, IssueReadError>;
  readonly createIssue: (
    input: IssueRepositoryRef & {
      readonly title: string;
      readonly body: string;
      readonly milestoneNumber: number | null;
      readonly writeKey: string;
      readonly recover?: boolean;
      readonly onCreated?: (issue: ThreadLinkedIssueType) => Effect.Effect<void, IssueReadError>;
    },
  ) => Effect.Effect<IssueChangeBaseline, IssueReadError>;
  readonly updateBody: (
    input: import("@t3tools/contracts").IssueRef & { readonly body: string },
  ) => Effect.Effect<void, IssueReadError>;
  readonly setMilestone: (
    input: import("@t3tools/contracts").IssueRef & { readonly milestoneNumber: number | null },
  ) => Effect.Effect<void, IssueReadError>;
  readonly setState: (
    input: import("@t3tools/contracts").IssueRef & { readonly state: "open" | "closed" },
  ) => Effect.Effect<void, IssueReadError>;
  readonly setParent: (input: {
    readonly parent: ThreadLinkedIssueType;
    readonly child: ThreadLinkedIssueType;
    readonly action: "add" | "remove";
  }) => Effect.Effect<void, IssueReadError>;
  /** Forgejo only: GitHub itself closes the issues a merged pull request's body names. */
  readonly closeIssuesFixedBy?: (pullRequest: IssueRef) => Effect.Effect<void, IssueReadError>;
  readonly repositories: () => Effect.Effect<IssueRepositoriesResultType, IssueReadError>;

  readonly withIdentity: <A, R>(
    scope: IssueRepositoryScope,
    operation: IssueReadError["operation"],
    read: (identity: IssueHostIdentity) => Effect.Effect<A, IssueReadError, R>,
  ) => Effect.Effect<A, IssueReadError, R>;
  readonly listIssuePage: (
    scope: IssueRepositoryScope,
    state: IssueListState,
    page: number,
    milestoneNumber?: number,
    etag?: string,
  ) => Effect.Effect<PageResponse<IssueSummaryType> & { readonly missing?: true }, IssueReadError>;
  readonly listMilestonePage: (
    scope: IssueRepositoryScope,
    state: IssueListState,
    page: number,
    etag?: string,
  ) => Effect.Effect<PageResponse<IssueMilestone>, IssueReadError>;
  readonly listMetadata: (
    scope: IssueRepositoryScope,
    numbers: ReadonlyArray<number>,
    roadmap: boolean,
  ) => Effect.Effect<ListMetadata>;
  readonly statuses: (
    host: string,
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<IssueStatusBatchResult[number] & IssueRef>, IssueReadError>;
  readonly detail: (
    input: IssueDetailInputType,
    identity: IssueHostIdentity,
  ) => Effect.Effect<IssueDetailResultType, IssueReadError>;
  readonly workRead: (input: IssueDetailInputType) => Effect.Effect<IssueWorkRead, IssueReadError>;
  readonly repositoryIdentity: (input: {
    readonly host: string;
    readonly repository: string;
  }) => Effect.Effect<
    Pick<ThreadLinkedIssueType, "host" | "repository" | "repositoryId">,
    IssueReadError
  >;
  readonly resolveLinkedIssue: (input: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<ThreadLinkedIssueType, IssueReadError>;
  readonly writeManagedComment: (input: {
    readonly issue: ThreadLinkedIssueType;
    readonly operation: "status_sync" | "closeout_create";
    readonly commentId?: string;
    readonly marker: string;
    readonly body: string;
  }) => Effect.Effect<{ readonly commentId: string }, IssueReadError>;
  readonly activitySince: (
    scope: IssueRepositoryRef,
    cursors: ActivityCursors,
  ) => Effect.Effect<
    {
      readonly issues: ActivityPage<InboxIssue>;
      readonly comments: ActivityPage<InboxComment>;
      readonly stateChanges: ActivityPage<InboxEvent>;
      readonly eventsAfter: number;
    },
    IssueReadError
  >;
  readonly listComments: (
    ref: IssueRef,
    options?: {
      readonly maxPages?: number;
      /** Stops reading further pages once the comments read so far satisfy it. */
      readonly until?: (comments: ReadonlyArray<InboxListedComment>) => boolean;
    },
  ) => Effect.Effect<
    {
      readonly comments: ReadonlyArray<InboxListedComment>;
      readonly complete: boolean;
    },
    IssueReadError
  >;
  readonly postComment: (ref: IssueRef, body: string) => Effect.Effect<InboxPosted, IssueReadError>;
  readonly postIssue: (
    scope: IssueRepositoryRef,
    input: {
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
    },
  ) => Effect.Effect<InboxPosted, IssueReadError>;
  readonly ensureLabels: (
    scope: IssueRepositoryRef,
    labels: ReadonlyArray<{ readonly name: string; readonly color: string }>,
  ) => Effect.Effect<void, IssueReadError>;
  readonly setLabels: (
    ref: IssueRef,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
  ) => Effect.Effect<void, IssueReadError>;
}

export interface IssueHostContext {
  readonly safeRepository: (host: string, value: string) => string | null;
  readonly resolveScope: (
    operation: IssueReadError["operation"],
    input: IssueRepositoryRef,
  ) => Effect.Effect<IssueRepositoryScope, IssueReadError>;
}

export const issueHostFor = (
  host: string,
  github: IssueHost,
  forgejo: ReadonlyMap<string, IssueHost> = new Map(),
): IssueHost => forgejo.get(host) ?? github;
