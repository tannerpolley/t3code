import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import {
  IssueReadError,
  IsoDateTime,
  type IssueSummary,
  type IssueMilestone,
  type IssueRef,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import type {
  IssueHost,
  IssueHostContext,
  IssueRepositoryScope,
  ListMetadata,
} from "./IssueHost.ts";

const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Actor = Schema.Struct({
  login: Schema.String,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const Milestone = Schema.Struct({
  id: Id,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  due_on: Schema.optional(Schema.NullOr(IsoDateTime)),
  open_issues: Schema.Number,
  closed_issues: Schema.Number,
});
const Repository = Schema.Struct({
  id: Id,
  full_name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  private: Schema.Boolean,
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  has_issues: Schema.Boolean,
  open_issues_count: Schema.Number,
  open_pr_counter: Schema.optional(Schema.Number),
  pushed_at: Schema.optional(Schema.NullOr(IsoDateTime)),
});
const Issue = Schema.Struct({
  id: Id,
  number: Id,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(Actor)),
  original_author: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Actor))),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          color: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  milestone: Schema.optional(Schema.NullOr(Milestone)),
  comments: Schema.Number,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  closed_at: Schema.optional(Schema.NullOr(IsoDateTime)),
  pull_request: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        merged: Schema.optional(Schema.Boolean),
        draft: Schema.optional(Schema.Boolean),
        html_url: Schema.optional(Schema.String),
      }),
    ),
  ),
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ id: Id, full_name: Schema.String }))),
});
const Comment = Schema.Struct({
  body: Schema.String,
  user: Schema.optional(Schema.NullOr(Actor)),
  original_author: Schema.optional(Schema.String),
  created_at: IsoDateTime,
  html_url: Schema.String,
});
const Timeline = Schema.Struct({
  type: Schema.String,
  ref_issue: Schema.optional(Schema.NullOr(Issue)),
  ref_action: Schema.optional(Schema.String),
  pull_request_url: Schema.optional(Schema.String),
});
type RawIssue = typeof Issue.Type;
const failure = (
  operation: IssueReadError["operation"],
  code: IssueReadError["code"],
  message: string,
) => new IssueReadError({ operation, code, message });

export function parseParentMarker(body: string): number | null {
  const markers = [...body.matchAll(/<!-- t3:parent=([1-9]\d*) -->/g)];
  const number = Number(markers[0]?.[1]);
  return markers.length === 1 && Number.isSafeInteger(number) ? number : null;
}
const actor = (user: typeof Actor.Type | null | undefined, original?: string) =>
  original
    ? { login: original, avatarUrl: null }
    : user
      ? { login: user.login, avatarUrl: user.avatar_url ?? null }
      : null;
const milestone = (
  scope: { host: string; repository: string },
  raw: typeof Milestone.Type,
): IssueMilestone => ({
  number: raw.id,
  title: raw.title,
  state: raw.state,
  dueAt: raw.due_on ?? null,
  openCount: raw.open_issues,
  closedCount: raw.closed_issues,
  url: `https://${scope.host}/${scope.repository}/milestone/${raw.id}`,
});
const summary = (scope: { host: string; repository: string }, raw: RawIssue): IssueSummary => ({
  number: raw.number,
  title: raw.title,
  url: raw.html_url,
  state: raw.state,
  stateReason: null,
  author: actor(raw.user, raw.original_author),
  assignees: (raw.assignees ?? []).map((user) => actor(user)!),
  labels: (raw.labels ?? []).map((label) => ({
    name: label.name,
    color: label.color?.replace(/^#/, "") ?? null,
  })),
  milestone: raw.milestone ? milestone(scope, raw.milestone) : null,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  closedAt: raw.closed_at ?? null,
  commentCount: raw.comments,
});
const linked = (
  scope: { host: string; repository: string },
  repositoryId: number,
  raw: RawIssue,
): ThreadLinkedIssue => ({
  host: scope.host,
  repository: scope.repository,
  repositoryId: String(repositoryId),
  id: String(raw.id),
  nodeId: `${repositoryId}/${raw.number}`,
  number: raw.number,
  url: raw.html_url,
  title: raw.title,
});
const repositoryPath = (repository: string) =>
  `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;

export const make = Effect.fn("IssueForgejoHost.make")(function* (
  context: IssueHostContext,
  host: string,
) {
  const cli = yield* ForgejoCli.ForgejoCli;
  const cwd = yield* HostProcess.HomeDirectory;
  const scopeFor = (ref: { repository: string }): IssueRepositoryScope => ({
    cwd,
    host,
    repository: ref.repository,
  });
  const request = Effect.fn("IssueForgejoHost.request")(function* <S extends Schema.Top>(
    scope: IssueRepositoryScope,
    path: string,
    schema: S,
    operation: IssueReadError["operation"] = "detail",
  ) {
    const response = yield* cli
      .api({ cwd: scope.cwd, host: scope.host, repository: scope.repository || "_/_", path })
      .pipe(
        Effect.mapError((error) =>
          failure(
            operation,
            error.reason === "authentication"
              ? "unauthenticated"
              : error.reason === "not-found" || error.reason === "forbidden"
                ? "inaccessible"
                : error.reason === "rate-limit"
                  ? "rate-limited"
                  : "upstream",
            "Forgejo issue request failed. Check this host's credentials and access.",
          ),
        ),
      );
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(response.stdout).pipe(
      Effect.mapError(() =>
        failure(operation, "invalid-response", "Forgejo returned an invalid issue response."),
      ),
    );
    return { value, headers: response.stderr };
  });
  const page = Effect.fn("IssueForgejoHost.page")(function* <S extends Schema.Top>(
    scope: IssueRepositoryScope,
    path: string,
    schema: S,
    current: number,
    operation: IssueReadError["operation"] = "detail",
  ) {
    const result = yield* request(
      scope,
      `${path}${path.includes("?") ? "&" : "?"}limit=50&page=${current}`,
      Schema.Array(schema),
      operation,
    );
    const next = /<([^>]+)>;\s*rel="next"/.exec(result.headers)?.[1];
    const nextPage = next
      ? yield* Effect.try({
          try: () => Number(new URL(next).searchParams.get("page")),
          catch: () =>
            failure(operation, "invalid-response", "Forgejo returned invalid pagination."),
        })
      : null;
    if (
      nextPage !== null &&
      (!Number.isSafeInteger(nextPage) || nextPage <= current || nextPage > 1_000_000)
    )
      return yield* failure(operation, "invalid-response", "Forgejo returned invalid pagination.");
    return { items: result.value, nextPage };
  });
  const all = Effect.fn("IssueForgejoHost.all")(function* <S extends Schema.Top>(
    scope: IssueRepositoryScope,
    path: string,
    schema: S,
  ) {
    const items: Array<S["Type"]> = [];
    let current: number | null = 1;
    for (let count = 0; current !== null && count < 100; count++) {
      const result: { items: ReadonlyArray<S["Type"]>; nextPage: number | null } = yield* page(
        scope,
        path,
        schema,
        current,
      );
      items.push(...result.items);
      current = result.nextPage;
    }
    return { items, complete: current === null };
  });
  const readIssue = Effect.fn("IssueForgejoHost.readIssue")(function* (ref: IssueRef) {
    const scope = yield* context.resolveScope("detail", ref);
    const raw = (yield* request(
      scope,
      `${repositoryPath(scope.repository)}/issues/${ref.number}`,
      Issue,
    )).value;
    if (raw.pull_request)
      return yield* failure("detail", "unsupported", "Pull requests are not issues.");
    if (raw.number !== ref.number)
      return yield* failure("detail", "invalid-response", "Forgejo returned another issue.");
    return raw;
  });
  const repositoryIdentity: IssueHost["repositoryIdentity"] = Effect.fn(
    "IssueForgejoHost.repositoryIdentity",
  )(function* (input) {
    const scope = yield* context.resolveScope("detail", input);
    const raw = (yield* request(scope, repositoryPath(scope.repository), Repository)).value;
    return { host: scope.host, repository: raw.full_name, repositoryId: String(raw.id) };
  });
  const resolveLinkedIssue: IssueHost["resolveLinkedIssue"] = Effect.fn(
    "IssueForgejoHost.resolveLinkedIssue",
  )(function* (input) {
    const identity = yield* repositoryIdentity(input);
    return linked(identity, Number(identity.repositoryId), yield* readIssue(input));
  });
  const blockers = Effect.fn("IssueForgejoHost.blockers")(function* (ref: IssueRef) {
    return yield* all(
      scopeFor(ref),
      `${repositoryPath(ref.repository)}/issues/${ref.number}/dependencies`,
      Issue,
    );
  });
  const children = Effect.fn("IssueForgejoHost.children")(function* (ref: IssueRef) {
    // Scan bodies so edited markers work even without a timeline cross-reference.
    const issues = yield* all(
      scopeFor(ref),
      `${repositoryPath(ref.repository)}/issues?type=issues&state=all`,
      Issue,
    );
    return {
      items: issues.items.filter(
        (raw) =>
          !raw.pull_request &&
          raw.number !== ref.number &&
          parseParentMarker(raw.body ?? "") === ref.number,
      ),
      complete: issues.complete,
    };
  });
  const workRead: IssueHost["workRead"] = Effect.fn("IssueForgejoHost.workRead")(function* (input) {
    const raw = yield* readIssue(input);
    const identity = yield* repositoryIdentity(input);
    const parentNumber = parseParentMarker(raw.body ?? "");
    const [parent, sub, dependencies] = yield* Effect.all(
      [
        parentNumber === null
          ? Effect.succeed(null)
          : resolveLinkedIssue({ ...input, number: parentNumber }),
        children(input),
        blockers(input),
      ],
      { concurrency: 3 },
    );
    const blockedBy = yield* Effect.forEach(
      dependencies.items,
      (dependency) =>
        Effect.gen(function* () {
          const repository = dependency.repository?.full_name ?? input.repository;
          const identity = dependency.repository
            ? { host, repository, repositoryId: String(dependency.repository.id) }
            : yield* repositoryIdentity({ host, repository });
          return {
            issue: linked(identity, Number(identity.repositoryId), dependency),
            state: dependency.state,
          };
        }),
      { concurrency: 8 },
    );
    return {
      issue: linked(identity, Number(identity.repositoryId), raw),
      state: raw.state,
      milestoneNumber: raw.milestone?.id ?? null,
      parent,
      subIssues: sub.items.map((child) => linked(identity, Number(identity.repositoryId), child)),
      blockedBy,
      parentComplete: true,
      subIssuesComplete: sub.complete,
      blockersComplete: dependencies.complete,
    };
  });
  const unsupported = () =>
    Effect.fail(
      new IssueReadError({
        operation: "detail",
        code: "unsupported",
        message: "Not supported on this issue host yet.",
        createOutcome: "rejected",
      }),
    );
  const transport: IssueHost = {
    repositoryIdentity,
    resolveLinkedIssue,
    workRead,
    withIdentity: (scope, operation, read) =>
      request(scope, "user", Schema.Struct({ id: Id, login: Schema.String }), operation).pipe(
        Effect.flatMap(({ value }) =>
          read({
            accountId: String(value.id),
            viewer: value.login,
            credentialFingerprint: `${host}/${value.id}`,
          }),
        ),
      ),
    repositories: Effect.fn("IssueForgejoHost.repositories")(function* () {
      const scope = { cwd, host, repository: "" };
      const user = (yield* request(
        scope,
        "user",
        Schema.Struct({ id: Id, login: Schema.String }),
        "repositories",
      )).value;
      const repositories = yield* all(scope, "user/repos", Repository);
      const orgs = yield* all(scope, "user/orgs", Schema.Struct({ username: Schema.String }));
      const orgRepos = yield* Effect.forEach(
        orgs.items,
        (org) => all(scope, `orgs/${encodeURIComponent(org.username)}/repos`, Repository),
        { concurrency: 8 },
      );
      const unique = new Map(
        [...repositories.items, ...orgRepos.flatMap((result) => result.items)].map((raw) => [
          raw.id,
          raw,
        ]),
      );
      const organizations = new Set(orgs.items.map((org) => org.username));
      return {
        viewer: { accountId: String(user.id), login: user.login },
        repositories: [...unique.values()]
          .filter((raw) => raw.has_issues)
          .map((raw) => ({
            host,
            repository: raw.full_name,
            owner: raw.owner.login,
            ownerIsOrganization: organizations.has(raw.owner.login),
            isPrivate: raw.private,
            isArchived: raw.archived,
            isFork: raw.fork,
            openIssuesAndPullRequests: raw.open_issues_count + (raw.open_pr_counter ?? 0),
            pushedAt: raw.pushed_at ?? null,
          })),
        complete:
          repositories.complete && orgs.complete && orgRepos.every((result) => result.complete),
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      };
    }),
    listIssuePage: Effect.fn("IssueForgejoHost.listIssuePage")(
      function* (scope, state, current, milestoneNumber) {
        const result = yield* page(
          scope,
          `${repositoryPath(scope.repository)}/issues?type=issues&state=${state}&sort=recentupdate${milestoneNumber === undefined ? "" : `&milestones=${milestoneNumber}`}`,
          Issue,
          current,
          "list",
        );
        const items = result.items
          .filter((raw) => !raw.pull_request)
          .map((raw) => ({
            ...summary(scope, raw),
            parent:
              parseParentMarker(raw.body ?? "") === null
                ? null
                : {
                    host,
                    repository: scope.repository,
                    number: parseParentMarker(raw.body ?? "")!,
                  },
          }));
        return { items, nextPage: result.nextPage };
      },
    ),
    listMilestonePage: Effect.fn("IssueForgejoHost.listMilestonePage")(
      function* (scope, state, current) {
        const result = yield* page(
          scope,
          `${repositoryPath(scope.repository)}/milestones?state=${state}`,
          Milestone,
          current,
          "list",
        );
        return {
          items: result.items.map((raw) => milestone(scope, raw)),
          nextPage: result.nextPage,
        };
      },
    ),
    listMetadata: Effect.fn("IssueForgejoHost.listMetadata")(function* (scope, numbers, roadmap) {
      const result: ListMetadata = new Map();
      const issues = yield* all(
        scope,
        `${repositoryPath(scope.repository)}/issues?type=issues&state=all`,
        Issue,
      ).pipe(Effect.option);
      if (issues._tag === "Some" && issues.value.complete) {
        for (const number of numbers) {
          const sub = issues.value.items.filter(
            (raw) =>
              !raw.pull_request &&
              raw.number !== number &&
              parseParentMarker(raw.body ?? "") === number,
          );
          result.set(number, {
            subIssues: {
              total: sub.length,
              completed: sub.filter((raw) => raw.state === "closed").length,
            },
          });
        }
      }
      if (!roadmap) return result;
      yield* Effect.forEach(
        numbers,
        (number) =>
          blockers({ ...scope, number }).pipe(
            Effect.match({
              onFailure: () => {
                result.set(number, { ...result.get(number), relationshipsComplete: false });
              },
              onSuccess: (dependencies) => {
                result.set(number, {
                  ...result.get(number),
                  blockedBy: dependencies.items.map((raw) => ({
                    host,
                    repository: raw.repository?.full_name ?? scope.repository,
                    number: raw.number,
                    state: raw.state,
                  })),
                  relationshipsComplete: dependencies.complete,
                });
              },
            }),
          ),
        { concurrency: 8 },
      );
      return result;
    }),
    statuses: Effect.fn("IssueForgejoHost.statuses")(function* (_, nodeIds) {
      return yield* Effect.forEach(
        nodeIds,
        (nodeId) =>
          Effect.gen(function* () {
            const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(nodeId);
            if (!match)
              return yield* failure(
                "detail",
                "invalid-response",
                "Invalid Forgejo issue identity.",
              );
            const repository = (yield* request(
              { cwd, host, repository: "" },
              `repositories/${match[1]}`,
              Repository,
            )).value;
            const ref = { host, repository: repository.full_name, number: Number(match[2]) };
            const raw = yield* readIssue(ref);
            const dependencies = yield* blockers(ref);
            if (!dependencies.complete)
              return yield* failure(
                "detail",
                "invalid-response",
                "Forgejo dependencies are incomplete.",
              );
            return {
              ...ref,
              nodeId,
              state: raw.state,
              stateReason: null,
              blockedBy: dependencies.items.map((raw) => ({ state: raw.state })),
              pullRequests: [],
            };
          }),
        { concurrency: 8 },
      );
    }),
    detail: Effect.fn("IssueForgejoHost.detail")(function* (input, identity) {
      if (input.expectedAccountId !== undefined && input.expectedAccountId !== identity.accountId)
        return yield* failure(
          "detail",
          "inaccessible",
          "The issue is not accessible to this account.",
        );
      const raw = yield* readIssue(input);
      const [comments, timeline, sub, dependencies] = yield* Effect.all(
        [
          all(
            scopeFor(input),
            `${repositoryPath(input.repository)}/issues/${input.number}/comments`,
            Comment,
          ),
          all(
            scopeFor(input),
            `${repositoryPath(input.repository)}/issues/${input.number}/timeline`,
            Timeline,
          ),
          children(input),
          blockers(input),
        ],
        { concurrency: 3 },
      );
      const refs = new Map(
        timeline.items.flatMap((event) =>
          event.ref_issue?.pull_request ? [[event.ref_issue.html_url, event] as const] : [],
        ),
      );
      return {
        repository: { host, repository: input.repository },
        viewer: { accountId: identity.accountId, login: identity.viewer },
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
        issue: {
          ...summary(input, raw),
          parent:
            parseParentMarker(raw.body ?? "") === null
              ? null
              : { host, repository: input.repository, number: parseParentMarker(raw.body ?? "")! },
          blockedBy: dependencies.items.map((dependency) => ({
            host,
            repository: dependency.repository?.full_name ?? input.repository,
            number: dependency.number,
            state: dependency.state,
          })),
          relationshipsComplete: dependencies.complete,
          ...(sub.complete
            ? {
                subIssues: {
                  total: sub.items.length,
                  completed: sub.items.filter((raw) => raw.state === "closed").length,
                },
              }
            : {}),
        },
        body: raw.body ?? "",
        comments: comments.items.map((comment) => ({
          author: actor(comment.user, comment.original_author),
          body: comment.body,
          createdAt: comment.created_at,
          url: comment.html_url,
        })),
        linkedPullRequests: [...refs.values()].map((event) => {
          const pr = event.ref_issue!;
          return {
            repository: pr.repository?.full_name ?? input.repository,
            number: pr.number,
            title: pr.title,
            state: pr.pull_request?.merged ? ("merged" as const) : pr.state,
            isDraft: pr.pull_request?.draft ?? false,
            url:
              pr.pull_request?.html_url ||
              event.pull_request_url ||
              pr.html_url.replace("/issues/", "/pulls/"),
            closesIssue: event.ref_action === "closes",
          };
        }),
      };
    }),
    readChangeState: Effect.fn("IssueForgejoHost.readChangeState")(function* (input) {
      const raw = yield* readIssue(input);
      return {
        issue: yield* resolveLinkedIssue(input),
        body: raw.body ?? "",
        state: raw.state,
        milestoneNumber: raw.milestone?.id ?? null,
        parent:
          parseParentMarker(raw.body ?? "") === null
            ? null
            : yield* resolveLinkedIssue({ ...input, number: parseParentMarker(raw.body ?? "")! }),
      };
    }),
    createIssue: unsupported,
    updateBody: unsupported,
    setMilestone: unsupported,
    setState: unsupported,
    setParent: unsupported,
    writeManagedComment: unsupported,
    activitySince: unsupported,
    listComments: unsupported,
    postComment: unsupported,
    postIssue: unsupported,
    ensureLabels: unsupported,
    setLabels: unsupported,
  };
  return transport;
});
