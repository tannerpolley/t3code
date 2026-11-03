import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import { parseGitLabAuthStatusHosts } from "@t3tools/source-control-gitlab/server/gitLabAuthStatus";
import {
  ISSUE_HOSTS,
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
import { parseParentMarker, updateParentMarker } from "./IssueParentMarker.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Actor = Schema.Struct({ username: Schema.String, avatar_url: Schema.NullOr(Schema.String) });
const Milestone = Schema.Struct({
  id: Id,
  iid: Id,
  title: Schema.String,
  state: Schema.Literals(["active", "closed"]),
  due_date: Schema.NullOr(Schema.String),
  web_url: Schema.optional(Schema.String),
});
const Project = Schema.Struct({
  id: Id,
  path_with_namespace: Schema.String,
  web_url: Schema.String,
  namespace: Schema.Struct({ full_path: Schema.String, kind: Schema.String }),
  visibility: Schema.String,
  archived: Schema.Boolean,
  issues_enabled: Schema.Boolean,
  forked_from_project: Schema.optional(Schema.Unknown),
  open_issues_count: Schema.optional(Schema.Number),
  last_activity_at: IsoDateTime,
});
const Issue = Schema.Struct({
  id: Id,
  iid: Id,
  project_id: Id,
  title: Schema.String,
  state: Schema.Literals(["opened", "closed"]),
  web_url: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Actor),
  assignees: Schema.Array(Actor),
  labels: Schema.Array(Schema.String),
  milestone: Schema.NullOr(Milestone),
  user_notes_count: Schema.Number,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  closed_at: Schema.NullOr(IsoDateTime),
});
const Note = Schema.Struct({
  id: Id,
  body: Schema.String,
  author: Actor,
  system: Schema.Boolean,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
const Created = Schema.Struct({ id: Id, iid: Id, title: Schema.String, web_url: Schema.String });
const decodeCreated = Schema.decodeUnknownEffect(Created);
const decodeIssue = Schema.decodeUnknownEffect(Issue);
const MergeRequest = Schema.Struct({
  state: Schema.Literals(["opened", "closed", "merged", "locked"]),
  target_branch: Schema.String,
  source_branch: Schema.String,
  sha: Schema.NullOr(Schema.String),
});
type RawIssue = typeof Issue.Type;
const failure = (
  operation: IssueReadError["operation"],
  code: IssueReadError["code"],
  message: string,
) => new IssueReadError({ operation, code, message });
const projectPath = (repository: string) => `projects/${encodeURIComponent(repository)}`;
const state = (raw: RawIssue) => (raw.state === "opened" ? ("open" as const) : ("closed" as const));
const actor = (raw: typeof Actor.Type | null) =>
  raw ? { login: raw.username, avatarUrl: raw.avatar_url } : null;
const milestone = (
  scope: { host: string; repository: string },
  raw: typeof Milestone.Type,
): IssueMilestone => ({
  number: raw.iid,
  title: raw.title,
  state: raw.state === "active" ? "open" : "closed",
  dueAt: raw.due_date ? `${raw.due_date}T00:00:00Z` : null,
  url: raw.web_url ?? `https://${scope.host}/${scope.repository}/-/milestones/${raw.iid}`,
  openCount: 0,
  closedCount: 0,
});
const summary = (scope: { host: string; repository: string }, raw: RawIssue): IssueSummary => ({
  number: raw.iid,
  title: raw.title,
  url: raw.web_url,
  state: state(raw),
  stateReason: null,
  author: actor(raw.author),
  assignees: raw.assignees.map((user) => actor(user)!),
  labels: raw.labels.map((name) => ({ name, color: null })),
  milestone: raw.milestone ? milestone(scope, raw.milestone) : null,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  closedAt: raw.closed_at,
  commentCount: raw.user_notes_count,
  parent:
    parseParentMarker(raw.description ?? "") === null
      ? null
      : {
          host: scope.host,
          repository: scope.repository,
          number: parseParentMarker(raw.description ?? "")!,
        },
});
const linked = (
  scope: { host: string; repository: string },
  projectId: number,
  raw: typeof Created.Type,
): ThreadLinkedIssue => ({
  ...scope,
  repositoryId: String(projectId),
  id: String(raw.id),
  nodeId: `${projectId}/${raw.iid}`,
  number: raw.iid,
  title: raw.title,
  url: raw.web_url,
});

export const make = Effect.fn("IssueGitLabHost.make")(function* (
  context: IssueHostContext,
  host: string,
) {
  const cli = yield* GitLabCli.GitLabCli;
  const cwd = yield* HostProcess.HomeDirectory;
  const scopeFor = (ref: { repository: string }) => ({ cwd, host, repository: ref.repository });
  const request = Effect.fn("IssueGitLabHost.request")(function* <S extends Schema.Top>(
    scope: IssueRepositoryScope,
    path: string,
    schema: S,
    operation: IssueReadError["operation"] = "detail",
    write?: { method: "POST" | "PUT"; body: unknown },
  ) {
    const response = yield* cli
      .execute({
        cwd: scope.cwd,
        host,
        args: [
          "api",
          "--hostname",
          host,
          path,
          ...(write ? ["--method", write.method, "--input", "-"] : []),
        ],
        ...(write ? { stdin: encodeJson(write.body) } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            operation,
            error._tag === "GitLabCliAuthenticationError"
              ? "unauthenticated"
              : error._tag === "GitLabCliRateLimitError"
                ? "rate-limited"
                : "upstream",
            "GitLab issue request failed. Check this host's credentials and access.",
          ),
        ),
      );
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      response.stdout || "null",
    ).pipe(
      Effect.mapError(() =>
        failure(operation, "invalid-response", "GitLab returned an invalid issue response."),
      ),
    );
  });
  const page = Effect.fn("IssueGitLabHost.page")(function* <S extends Schema.Top>(
    scope: IssueRepositoryScope,
    path: string,
    schema: S,
    current: number,
    operation: IssueReadError["operation"] = "detail",
  ) {
    const items = yield* request(
      scope,
      `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${current}`,
      Schema.Array(schema),
      operation,
    );
    return { items, nextPage: items.length === 50 ? current + 1 : null };
  });
  const all = Effect.fn("IssueGitLabHost.all")(function* <S extends Schema.Top>(
    scope: IssueRepositoryScope,
    path: string,
    schema: S,
    maxPages = 100,
  ) {
    const items: Array<S["Type"]> = [];
    let current: number | null = 1;
    for (let count = 0; current !== null && count < maxPages; count++) {
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
  const readIssue = Effect.fn("IssueGitLabHost.readIssue")(function* (ref: IssueRef) {
    const scope = yield* context.resolveScope("detail", ref);
    const raw = yield* request(
      scope,
      `${projectPath(scope.repository)}/issues/${ref.number}`,
      Issue,
    );
    if (raw.iid !== ref.number)
      return yield* failure("detail", "invalid-response", "GitLab returned another issue.");
    return raw;
  });
  const repositoryIdentity: IssueHost["repositoryIdentity"] = Effect.fn(
    "IssueGitLabHost.repositoryIdentity",
  )(function* (ref) {
    const scope = yield* context.resolveScope("detail", ref);
    const raw = yield* request(scope, projectPath(scope.repository), Project);
    return { host, repository: raw.path_with_namespace, repositoryId: String(raw.id) };
  });
  const resolveLinkedIssue: IssueHost["resolveLinkedIssue"] = Effect.fn(
    "IssueGitLabHost.resolveLinkedIssue",
  )(function* (ref) {
    const identity = yield* repositoryIdentity(ref);
    return linked(identity, Number(identity.repositoryId), yield* readIssue(ref));
  });
  const children = Effect.fn("IssueGitLabHost.children")(function* (ref: IssueRef) {
    const rows = yield* all(
      scopeFor(ref),
      `${projectPath(ref.repository)}/issues?scope=all&state=all`,
      Issue,
    );
    return {
      items: rows.items.filter(
        (raw) => raw.iid !== ref.number && parseParentMarker(raw.description ?? "") === ref.number,
      ),
      complete: rows.complete,
    };
  });
  const patchIssue = Effect.fn("IssueGitLabHost.patchIssue")(function* (
    ref: IssueRef,
    body: unknown,
  ) {
    const scope = yield* context.resolveScope("detail", ref);
    yield* request(
      scope,
      `${projectPath(scope.repository)}/issues/${ref.number}`,
      Schema.Unknown,
      "detail",
      { method: "PUT", body },
    );
  });
  const resolveMilestone = Effect.fn("IssueGitLabHost.resolveMilestone")(function* (
    scope: IssueRepositoryScope,
    number: number,
  ) {
    const rows = yield* request(
      scope,
      `${projectPath(scope.repository)}/milestones?iids[]=${number}`,
      Schema.Array(Milestone),
    );
    const found = rows.find((row) => row.iid === number);
    if (!found)
      return yield* failure("detail", "inaccessible", "The GitLab milestone was not found.");
    return found;
  });
  const baseline = Effect.fn("IssueGitLabHost.baseline")(function* (
    scope: { host: string; repository: string },
    raw: RawIssue,
  ) {
    const parent = parseParentMarker(raw.description ?? "");
    return {
      issue: linked(scope, raw.project_id, raw),
      body: raw.description ?? "",
      state: state(raw),
      milestoneNumber: raw.milestone?.iid ?? null,
      parent: parent === null ? null : yield* resolveLinkedIssue({ ...scope, number: parent }),
    };
  });
  const transport: IssueHost = {
    capabilities: ISSUE_HOSTS.gitlab!.capabilities,
    repositoryIdentity,
    resolveLinkedIssue,
    withIdentity: (scope, operation, read) =>
      request(scope, "user", Schema.Struct({ id: Id, username: Schema.String }), operation).pipe(
        Effect.flatMap((user) =>
          read({
            accountId: String(user.id),
            viewer: user.username,
            credentialFingerprint: `${host}/${user.id}`,
          }),
        ),
      ),
    repositories: Effect.fn("IssueGitLabHost.repositories")(function* () {
      const scope = { cwd, host, repository: "" };
      const user = yield* request(
        scope,
        "user",
        Schema.Struct({ id: Id, username: Schema.String }),
        "repositories",
      );
      const rows = yield* all(scope, "projects?membership=true&simple=false", Project);
      return {
        viewer: { accountId: String(user.id), login: user.username },
        repositories: rows.items
          .filter((raw) => raw.issues_enabled)
          .map((raw) => ({
            host,
            repository: raw.path_with_namespace,
            owner: raw.namespace.full_path,
            ownerIsOrganization: raw.namespace.kind === "group",
            isPrivate: raw.visibility !== "public",
            isArchived: raw.archived,
            isFork: raw.forked_from_project != null,
            openIssuesAndPullRequests: raw.open_issues_count ?? 0,
            pushedAt: raw.last_activity_at,
          })),
        complete: rows.complete,
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      };
    }),
    listIssuePage: Effect.fn("IssueGitLabHost.listIssuePage")(
      function* (scope, requestedState, current, milestoneNumber) {
        const base = projectPath(scope.repository);
        // The issues endpoint filters milestones by title, not numeric ID.
        const filter =
          milestoneNumber === undefined
            ? ""
            : `&milestone=${encodeURIComponent((yield* resolveMilestone(scope, milestoneNumber)).title)}`;
        const result = yield* page(
          scope,
          `${base}/issues?scope=all&state=${requestedState === "open" ? "opened" : "all"}&order_by=updated_at&sort=desc${filter}`,
          Issue,
          current,
          "list",
        );
        return { items: result.items.map((raw) => summary(scope, raw)), nextPage: result.nextPage };
      },
    ),
    listMilestonePage: Effect.fn("IssueGitLabHost.listMilestonePage")(
      function* (scope, requestedState, current) {
        const base = projectPath(scope.repository);
        const result = yield* page(
          scope,
          `${base}/milestones${requestedState === "open" ? "?state=active" : ""}`,
          Milestone,
          current,
          "list",
        );
        const items = yield* Effect.forEach(
          result.items,
          (raw) =>
            all(scope, `${base}/milestones/${raw.id}/issues`, Issue).pipe(
              Effect.flatMap((issues) =>
                issues.complete
                  ? Effect.succeed({
                      ...milestone(scope, raw),
                      openCount: issues.items.filter((row) => row.state === "opened").length,
                      closedCount: issues.items.filter((row) => row.state === "closed").length,
                    })
                  : Effect.fail(
                      failure(
                        "list",
                        "invalid-response",
                        "GitLab milestone issue pagination is incomplete.",
                      ),
                    ),
              ),
            ),
          { concurrency: 8 },
        );
        return { items, nextPage: result.nextPage };
      },
    ),
    listMetadata: Effect.fn("IssueGitLabHost.listMetadata")(function* (scope, numbers) {
      const result: ListMetadata = new Map();
      const rows = yield* all(
        scope,
        `${projectPath(scope.repository)}/issues?scope=all&state=all`,
        Issue,
      ).pipe(Effect.option);
      if (Option.isSome(rows) && rows.value.complete)
        for (const number of numbers) {
          const sub = rows.value.items.filter(
            (raw) => raw.iid !== number && parseParentMarker(raw.description ?? "") === number,
          );
          result.set(number, {
            subIssues: {
              total: sub.length,
              completed: sub.filter((raw) => raw.state === "closed").length,
            },
            relationshipsComplete: true,
            blockedBy: [],
          });
        }
      return result;
    }),
    statuses: Effect.fn("IssueGitLabHost.statuses")(function* (_, nodeIds) {
      return yield* Effect.forEach(
        nodeIds,
        (nodeId) =>
          Effect.gen(function* () {
            const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(nodeId);
            if (!match)
              return yield* failure("detail", "invalid-response", "Invalid GitLab issue identity.");
            const project = yield* request(
              { cwd, host, repository: "" },
              `projects/${match[1]}`,
              Project,
            );
            const ref = { host, repository: project.path_with_namespace, number: Number(match[2]) };
            return {
              ...ref,
              nodeId,
              state: state(yield* readIssue(ref)),
              stateReason: null,
              blockedBy: [],
              pullRequests: [],
            };
          }),
        { concurrency: 8 },
      );
    }),
    workRead: Effect.fn("IssueGitLabHost.workRead")(function* (ref) {
      const raw = yield* readIssue(ref);
      const base = yield* baseline(ref, raw);
      const sub = yield* children(ref);
      return {
        issue: base.issue,
        state: base.state,
        milestoneNumber: base.milestoneNumber,
        parent: base.parent,
        subIssues: sub.items.map((row) => linked(ref, row.project_id, row)),
        blockedBy: [],
        parentComplete: true,
        subIssuesComplete: sub.complete,
        blockersComplete: true,
      };
    }),
    detail: Effect.fn("IssueGitLabHost.detail")(function* (ref, identity) {
      if (ref.expectedAccountId !== undefined && ref.expectedAccountId !== identity.accountId)
        return yield* failure(
          "detail",
          "inaccessible",
          "The issue is not accessible to this account.",
        );
      const raw = yield* readIssue(ref);
      const sub = yield* children(ref);
      const notes = yield* all(
        scopeFor(ref),
        `${projectPath(ref.repository)}/issues/${ref.number}/notes?sort=asc`,
        Note,
      );
      return {
        repository: { host, repository: ref.repository },
        viewer: { accountId: identity.accountId, login: identity.viewer },
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
        issue: {
          ...summary(ref, raw),
          blockedBy: [],
          relationshipsComplete: sub.complete,
          ...(sub.complete
            ? {
                subIssues: {
                  total: sub.items.length,
                  completed: sub.items.filter((row) => row.state === "closed").length,
                },
              }
            : {}),
        },
        body: raw.description ?? "",
        comments: notes.items
          .filter((note) => !note.system)
          .map((note) => ({
            author: actor(note.author),
            body: note.body,
            createdAt: note.created_at,
            url: `${raw.web_url}#note_${note.id}`,
          })),
        linkedPullRequests: [],
      };
    }),
    readChangeState: Effect.fn("IssueGitLabHost.readChangeState")(function* (ref) {
      return yield* baseline(ref, yield* readIssue(ref));
    }),
    createIssue: Effect.fn("IssueGitLabHost.createIssue")(function* (input) {
      let attempted = false;
      return yield* Effect.gen(function* () {
        const scope = yield* context.resolveScope("detail", input);
        const identity = yield* repositoryIdentity(input);
        const marker = `<!-- t3-issue-change:${input.writeKey} -->`;
        let raw: RawIssue;
        if (input.recover !== false) {
          const rows = yield* all(
            scope,
            `${projectPath(scope.repository)}/issues?scope=all&state=all`,
            Issue,
          );
          const existing = rows.items.find((row) => row.description?.includes(marker));
          if (!existing)
            return yield* new IssueReadError({
              operation: "detail",
              code: "upstream",
              createOutcome: rows.complete ? "unresolved" : "uncertain",
              message:
                "The earlier create may have succeeded. Check GitLab and mark this change resolved; creation was not retried.",
            });
          raw = existing;
        } else {
          const milestoneId =
            input.milestoneNumber === null
              ? undefined
              : (yield* resolveMilestone(scope, input.milestoneNumber)).id;
          attempted = true;
          const response = yield* request(
            scope,
            `${projectPath(scope.repository)}/issues`,
            Schema.Unknown,
            "detail",
            {
              method: "POST",
              body: {
                title: input.title,
                description: `${input.body}\n\n${marker}`,
                ...(milestoneId === undefined ? {} : { milestone_id: milestoneId }),
              },
            },
          );
          const receipt = yield* decodeCreated(response).pipe(
            Effect.mapError(() =>
              failure(
                "detail",
                "invalid-response",
                "GitLab returned an invalid created issue identity.",
              ),
            ),
          );
          yield* (
            input.onCreated?.(linked(identity, Number(identity.repositoryId), receipt)) ??
              Effect.void
          );
          raw = yield* decodeIssue(response).pipe(
            Effect.mapError(() =>
              failure("detail", "invalid-response", "GitLab returned an invalid created issue."),
            ),
          );
        }
        return yield* baseline(identity, raw);
      }).pipe(
        Effect.mapError(
          (error) =>
            new IssueReadError({
              operation: error.operation,
              code: error.code,
              message: error.message,
              retryAt: error.retryAt,
              createOutcome:
                error.createOutcome ??
                (input.recover !== false || attempted ? "uncertain" : "rejected"),
            }),
        ),
      );
    }),
    updateBody: Effect.fn("IssueGitLabHost.updateBody")((input) =>
      patchIssue(input, { description: input.body }),
    ),
    setMilestone: Effect.fn("IssueGitLabHost.setMilestone")(function* (input) {
      const scope = yield* context.resolveScope("detail", input);
      const id =
        input.milestoneNumber === null
          ? 0
          : (yield* resolveMilestone(scope, input.milestoneNumber)).id;
      yield* patchIssue(input, { milestone_id: id });
    }),
    setState: Effect.fn("IssueGitLabHost.setState")((input) =>
      patchIssue(input, { state_event: input.state === "open" ? "reopen" : "close" }),
    ),
    setBlockedBy: () =>
      Effect.fail(
        failure(
          "detail",
          "unsupported",
          "GitLab blocking links depend on project tier and are not supported.",
        ),
      ),
    setParent: Effect.fn("IssueGitLabHost.setParent")(function* ({ parent, child, action }) {
      if (
        parent.host !== child.host ||
        parent.repository !== child.repository ||
        parent.repositoryId !== child.repositoryId ||
        parent.id === child.id
      )
        return yield* failure(
          "detail",
          "unsupported",
          "Parent and child must be different issues in the same repository.",
        );
      const body = (yield* readIssue(child)).description ?? "";
      const next = updateParentMarker(body, parent.number, action);
      if (next !== body) yield* patchIssue(child, { description: next });
    }),
    pullRequest: Effect.fn("IssueGitLabHost.pullRequest")(function* (ref) {
      const raw = yield* request(
        scopeFor(ref),
        `${projectPath(ref.repository)}/merge_requests/${ref.number}`,
        MergeRequest,
      );
      return {
        state: raw.state === "merged" ? "merged" : raw.state === "closed" ? "closed" : "open",
        baseBranch: raw.target_branch,
        headBranch: raw.source_branch,
        headSha: raw.sha,
      };
    }),
    closeIssuesFixedBy: Effect.fn("IssueGitLabHost.closeIssuesFixedBy")(function* (ref) {
      const scope = yield* context.resolveScope("detail", ref);
      const base = `${projectPath(scope.repository)}/merge_requests/${ref.number}`;
      const mr = yield* request(scope, base, MergeRequest);
      if (mr.state !== "merged") return;
      // Let GitLab interpret its configurable closing keywords and cross-project references.
      const rows = yield* all(scope, `${base}/closes_issues`, Issue);
      if (!rows.complete)
        return yield* failure(
          "detail",
          "invalid-response",
          "GitLab closing issue pagination is incomplete.",
        );
      yield* Effect.forEach(
        rows.items,
        (row) =>
          Effect.gen(function* () {
            const project = yield* request(scope, `projects/${row.project_id}`, Project);
            const target = { host, repository: project.path_with_namespace, number: row.iid };
            if ((yield* readIssue(target)).state === "closed") return;
            yield* patchIssue(target, { state_event: "close" });
            yield* transport.postComment(
              target,
              `Closed by ${`https://${host}/${scope.repository}/-/merge_requests/${ref.number}`}, which merged.`,
            );
          }).pipe(
            Effect.catchTags({
              IssueReadError: (error) =>
                Effect.logWarning("closing an issue a merged merge request names failed", {
                  issue: row.iid,
                  mergeRequest: ref.number,
                  reason: error.message,
                }),
            }),
          ),
        { discard: true },
      );
    }),
    listComments: Effect.fn("IssueGitLabHost.listComments")(function* (ref, options) {
      const scope = yield* context.resolveScope("detail", ref);
      const comments: Array<{ id: number; body: string; html_url: string }> = [];
      let current: number | null = 1;
      for (let count = 0; current !== null && count < (options?.maxPages ?? 100); count++) {
        const result: { items: ReadonlyArray<typeof Note.Type>; nextPage: number | null } =
          yield* page(
            scope,
            `${projectPath(scope.repository)}/issues/${ref.number}/notes?sort=asc`,
            Note,
            current,
          );
        comments.push(
          ...result.items
            .filter((note) => !note.system)
            .map((note) => ({
              id: note.id,
              body: note.body,
              html_url: `https://${host}/${scope.repository}/-/issues/${ref.number}#note_${note.id}`,
            })),
        );
        current = result.nextPage;
        if (options?.until?.(comments)) return { comments, complete: true };
      }
      return { comments, complete: current === null };
    }),
    postComment: Effect.fn("IssueGitLabHost.postComment")(function* (ref, body) {
      const scope = yield* context.resolveScope("detail", ref);
      const note = yield* request(
        scope,
        `${projectPath(scope.repository)}/issues/${ref.number}/notes`,
        Schema.Struct({ id: Id }),
        "detail",
        { method: "POST", body: { body } },
      );
      return {
        id: note.id,
        html_url: `https://${host}/${scope.repository}/-/issues/${ref.number}#note_${note.id}`,
      };
    }),
    writeManagedComment: Effect.fn("IssueGitLabHost.writeManagedComment")(function* (input) {
      const scope = yield* context.resolveScope("detail", input.issue);
      const body = input.body.includes(input.marker)
        ? input.body
        : `${input.body.trimEnd()}\n\n${input.marker}`;
      const comments = yield* transport.listComments(input.issue, {
        until: (rows) => rows.some((row) => row.body?.includes(input.marker)),
      });
      const existing = comments.comments.find((row) => row.body?.includes(input.marker));
      if (!existing && !comments.complete)
        return yield* failure(
          "detail",
          "invalid-response",
          "GitLab comment pagination is incomplete; comment was not created.",
        );
      if (existing && input.operation === "closeout_create")
        return { commentId: String(existing.id) };
      if (existing) {
        yield* request(
          scope,
          `${projectPath(scope.repository)}/issues/${input.issue.number}/notes/${existing.id}`,
          Schema.Unknown,
          "detail",
          { method: "PUT", body: { body } },
        );
        return { commentId: String(existing.id) };
      }
      return { commentId: String((yield* transport.postComment(input.issue, body)).id) };
    }),
    activitySince: () =>
      Effect.fail(failure("detail", "unsupported", "GitLab live issue activity is not supported.")),
    postIssue: Effect.fn("IssueGitLabHost.postIssue")(function* (input, payload) {
      const scope = yield* context.resolveScope("detail", input);
      const raw = yield* request(
        scope,
        `${projectPath(scope.repository)}/issues`,
        Created,
        "detail",
        {
          method: "POST",
          body: {
            title: payload.title,
            description: payload.body,
            labels: payload.labels.join(","),
          },
        },
      );
      return { id: raw.id, number: raw.iid, html_url: raw.web_url };
    }),
    ensureLabels: Effect.fn("IssueGitLabHost.ensureLabels")(function* (input, labels) {
      const scope = yield* context.resolveScope("detail", input);
      const base = `${projectPath(scope.repository)}/labels`;
      const rows = yield* all(scope, base, Schema.Struct({ name: Schema.String }));
      if (!rows.complete)
        return yield* failure(
          "detail",
          "invalid-response",
          "GitLab label pagination is incomplete.",
        );
      const existing = new Set(rows.items.map((row) => row.name));
      for (const label of labels)
        if (!existing.has(label.name)) {
          yield* request(scope, base, Schema.Unknown, "detail", {
            method: "POST",
            body: { ...label, color: `#${label.color.replace(/^#/, "")}` },
          });
          existing.add(label.name);
        }
    }),
    setLabels: Effect.fn("IssueGitLabHost.setLabels")((ref, add, remove) =>
      patchIssue(ref, { add_labels: add.join(","), remove_labels: remove.join(",") }),
    ),
  };
  return transport;
});

export const discover = Effect.fn("IssueGitLabHost.discover")(function* (
  context: IssueHostContext,
) {
  const cli = Option.getOrUndefined(yield* Effect.serviceOption(GitLabCli.GitLabCli));
  const cwd = yield* HostProcess.HomeDirectory;
  const hosts = new Map<string, IssueHost>();
  if (!cli) return hosts;
  const output = yield* cli
    .execute({ cwd, args: ["auth", "status", "--all"], allowNonZeroExit: true })
    .pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "" })));
  // gitlab.com is known even before login; self-managed hosts come from glab credentials.
  const names = new Set([
    "gitlab.com",
    ...parseGitLabAuthStatusHosts(`${output.stdout}\n${output.stderr}`)
      .filter((entry) => entry.account !== null)
      .map((entry) => entry.host),
  ]);
  for (const host of names)
    hosts.set(
      host,
      yield* make(context, host).pipe(Effect.provideService(GitLabCli.GitLabCli, cli)),
    );
  return hosts;
});
