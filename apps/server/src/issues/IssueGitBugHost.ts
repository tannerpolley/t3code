import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  ISSUE_HOSTS,
  IssueReadError,
  type IssueRef,
  type IssueSummary,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { issueRepositoryOf } from "./issueRepositoryOf.ts";
import type { IssueHost } from "./IssueHost.ts";

/** Opted-in repositories are served under this host name, whatever their remote is. */
export const GIT_BUG_HOST = "git-bug";

const Time = Schema.Struct({ time: Schema.String });
const Person = Schema.Struct({ name: Schema.String, login: Schema.String });
const Listed = Schema.Struct({
  id: Schema.String,
  human_id: Schema.String,
  create_time: Time,
  edit_time: Time,
  status: Schema.Literals(["open", "closed"]),
  labels: Schema.NullOr(Schema.Array(Schema.String)),
  title: Schema.String,
  author: Person,
  comments: Schema.Number,
});
const Shown = Schema.Struct({
  ...Listed.fields,
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      human_id: Schema.String,
      author: Person,
      message: Schema.String,
    }),
  ),
});
type Bug = typeof Shown.Type;

type Git = (args: ReadonlyArray<string>) => Effect.Effect<string, IssueReadError>;
const failure = (code: IssueReadError["code"], message: string) =>
  new IssueReadError({ operation: "detail", code, message });
const unsupported = (what: string) =>
  Effect.fail(failure("unsupported", `git-bug issues have no ${what}.`));
const iso = (time: string) => DateTime.formatIso(DateTime.makeUnsafe(time));
// ponytail: numbers are git-bug's 7-hex human id read as an integer; two bugs sharing a prefix
// collide (git-bug then refuses the ambiguous id). Store a number on each bug if that happens.
const numberOf = (humanId: string) => Number.parseInt(humanId.slice(0, 7), 16);
const prefixOf = (number: number) => number.toString(16).padStart(7, "0");
const issueUrl = (repository: string, number: number) =>
  `https://${GIT_BUG_HOST}/${repository}/issues/${number}`;
const person = (raw: typeof Person.Type) => {
  const login = (raw.login || raw.name).trim();
  return login ? { login, avatarUrl: null } : null;
};

export interface GitBugCheckout {
  readonly repository: string;
  readonly cwd: string;
}

/**
 * Issues kept in the repository by git-bug (`refs/bugs/*`), for the opted-in `checkouts`. Every
 * git-bug command for one repository runs through one queue.
 */
export const make = Effect.fn("IssueGitBugHost.make")(function* (
  checkouts: Effect.Effect<ReadonlyArray<GitBugCheckout>>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const commonDir = (cwd: string) =>
    runner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      })
      .pipe(
        Effect.map((result) => result.stdout.trim() || cwd),
        Effect.orElseSucceed(() => cwd),
      );
  // git-bug locks the whole repository per command and fails, rather than waits, when it is held.
  // ponytail: in-process only; the user's own git-bug CLI or a second T3 server still hits the
  // lock (reported as a retryable error). A file lock in the common .git dir would cover them.
  const queues = new Map<string, Semaphore.Semaphore>();
  // Messages go through -m: git-bug reads -F like an editor message and drops lines starting
  // with '#'. ponytail: Linux caps one argument at 128 KiB, so larger bodies fail to spawn.
  const exec = Effect.fn("IssueGitBugHost.exec")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner
      .run({ command: "git-bug", args, cwd })
      .pipe(
        Effect.mapError((error) =>
          failure(
            "upstream",
            error._tag === "ProcessSpawnError"
              ? "git-bug is not installed on the T3 server's machine."
              : `git-bug failed: ${error.message}`,
          ),
        ),
      );
    if (result.code === 0) return result.stdout;
    const message = result.stderr.trim().split("\n").at(-1) ?? "";
    return yield* failure(
      /No identity is set/.test(result.stderr)
        ? "unauthenticated"
        : /already locked/.test(result.stderr)
          ? "rate-limited"
          : /no bug matching|doesn't exist/i.test(result.stderr)
            ? "inaccessible"
            : "upstream",
      /No identity is set/.test(result.stderr)
        ? "git-bug has no identity in this repository; run `git bug user new` (or `git bug user adopt`) there first."
        : `git-bug failed: ${message}`,
    );
  });
  /** Holds the repository's queue for every git-bug command `use` runs. */
  const locked = Effect.fn("IssueGitBugHost.locked")(function* <A>(
    repository: string,
    use: (git: Git) => Effect.Effect<A, IssueReadError>,
  ) {
    const cwds = (yield* checkouts)
      .filter((row) => row.repository.toLowerCase() === repository.toLowerCase())
      .map((row) => row.cwd);
    if (cwds.length === 0)
      return yield* failure(
        "scope-unavailable",
        `No project opted in to git-bug for ${repository}; set \`git config t3.issues git-bug\` in its checkout.`,
      );
    // Remotes on different hosts can share an owner/name; linked worktrees share one .git.
    const keys = new Set(yield* Effect.forEach(cwds, commonDir));
    if (keys.size > 1)
      return yield* failure(
        "scope-unavailable",
        `More than one repository opted in to git-bug is named ${repository}; opt all but one out.`,
      );
    const key = [...keys][0]!;
    let queue = queues.get(key);
    if (queue === undefined) queues.set(key, (queue = Semaphore.makeUnsafe(1)));
    return yield* use((args) => exec(cwds[0]!, args)).pipe(queue.withPermits(1));
  });

  const decode = <S extends Schema.Top>(schema: S, stdout: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(stdout).pipe(
      Effect.mapError(() => failure("invalid-response", "git-bug returned unreadable output.")),
    );
  // git-bug falls back to its selected bug when an id matches none, so every mutation first
  // verifies the issue here and then passes its full id.
  const show = (git: Git, number: number) =>
    git(["bug", "show", prefixOf(number), "--format", "json"]).pipe(
      Effect.flatMap((stdout) => decode(Shown, stdout)),
      Effect.filterOrFail(
        (bug) => numberOf(bug.human_id) === number,
        () => failure("inaccessible", "git-bug returned another issue."),
      ),
    );
  const list = (git: Git, state: "open" | "all") =>
    git([
      "bug",
      "--format",
      "json",
      "--by",
      "edit",
      "--direction",
      "desc",
      ...(state === "open" ? ["--status", "open"] : []),
    ]).pipe(Effect.flatMap((stdout) => decode(Schema.Array(Listed), stdout || "[]")));
  const linked = (
    repository: string,
    bug: Pick<Bug, "id" | "human_id" | "title">,
  ): ThreadLinkedIssue => ({
    host: GIT_BUG_HOST,
    repository,
    repositoryId: repository.toLowerCase(),
    id: bug.id,
    nodeId: `${repository.toLowerCase()}#${bug.id}`,
    number: numberOf(bug.human_id),
    url: issueUrl(repository, numberOf(bug.human_id)),
    title: bug.title,
  });
  const summary = (
    repository: string,
    bug: Omit<typeof Listed.Type, "comments">,
    commentCount: number,
  ): IssueSummary => ({
    number: numberOf(bug.human_id),
    title: bug.title,
    url: issueUrl(repository, numberOf(bug.human_id)),
    state: bug.status,
    stateReason: null,
    author: person(bug.author),
    assignees: [],
    labels: (bug.labels ?? []).map((name) => ({ name, color: null })),
    milestone: null,
    createdAt: iso(bug.create_time.time),
    updatedAt: iso(bug.edit_time.time),
    closedAt: null,
    // The first git-bug comment is the issue body.
    commentCount: Math.max(0, commentCount - 1),
  });
  const baseline = (repository: string, bug: Bug) => ({
    issue: linked(repository, bug),
    body: bug.comments[0]?.message ?? "",
    state: bug.status,
    milestoneNumber: null,
    parent: null,
  });
  const comment = Effect.fn("IssueGitBugHost.comment")(function* (
    git: Git,
    ref: IssueRef,
    body: string,
  ) {
    const bug = yield* show(git, ref.number);
    yield* git(["bug", "comment", "new", bug.id, "--non-interactive", "-m", body]);
    const created = (yield* show(git, ref.number)).comments.at(-1)!;
    return {
      id: numberOf(created.human_id),
      humanId: created.human_id,
      html_url: `${issueUrl(ref.repository, ref.number)}#${created.human_id}`,
    };
  });
  const create = Effect.fn("IssueGitBugHost.create")(function* (
    git: Git,
    title: string,
    body: string,
  ) {
    const created = yield* git([
      "bug",
      "new",
      "--non-interactive",
      "-t",
      title.replaceAll(/\s+/g, " ").trim(),
      "-m",
      body,
    ]);
    const humanId = /^([0-9a-f]{7}) created/m.exec(created)?.[1];
    if (humanId === undefined)
      return yield* failure("invalid-response", "git-bug did not report the created issue.");
    return numberOf(humanId);
  });
  const workRead: IssueHost["workRead"] = (input) =>
    locked(input.repository, (git) => show(git, input.number)).pipe(
      Effect.map((bug) => ({
        issue: linked(input.repository, bug),
        state: bug.status,
        milestoneNumber: null,
        parent: null,
        subIssues: [],
        blockedBy: [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: true,
      })),
    );
  const host: IssueHost = {
    capabilities: ISSUE_HOSTS[GIT_BUG_HOST]!.capabilities,
    repositoryIdentity: (input) =>
      Effect.succeed({
        host: GIT_BUG_HOST,
        repository: input.repository,
        repositoryId: input.repository.toLowerCase(),
      }),
    resolveLinkedIssue: (input) =>
      locked(input.repository, (git) => show(git, input.number)).pipe(
        Effect.map((bug) => linked(input.repository, bug)),
      ),
    workRead,
    // git-bug has no accounts: every reader of a repository sees the same issues.
    withIdentity: (scope, _operation, read) =>
      read({
        accountId: GIT_BUG_HOST,
        viewer: GIT_BUG_HOST,
        credentialFingerprint: `${GIT_BUG_HOST}/${scope.repository}`,
      }),
    repositories: Effect.fn("IssueGitBugHost.repositories")(function* () {
      const unique = new Map((yield* checkouts).map((row) => [row.repository.toLowerCase(), row]));
      const repositories = yield* Effect.forEach([...unique.values()], (row) =>
        locked(row.repository, (git) => list(git, "open")).pipe(
          Effect.map((open) => ({
            host: GIT_BUG_HOST,
            repository: row.repository,
            owner: row.repository.split("/")[0]!,
            ownerIsOrganization: false,
            isPrivate: true,
            isArchived: false,
            isFork: false,
            openIssuesAndPullRequests: open.length,
            pushedAt: null,
          })),
        ),
      );
      return {
        viewer: { accountId: GIT_BUG_HOST, login: GIT_BUG_HOST },
        repositories,
        complete: true,
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      };
    }),
    listIssuePage: Effect.fn("IssueGitBugHost.listIssuePage")(
      function* (scope, state, page, milestoneNumber) {
        // ponytail: the whole repository is one page; page it if repositories grow past a few hundred issues.
        if (page > 1 || milestoneNumber !== undefined) return { items: [], nextPage: null };
        const bugs = yield* locked(scope.repository, (git) => list(git, state));
        return {
          items: bugs.map((bug) => summary(scope.repository, bug, bug.comments)),
          nextPage: null,
        };
      },
    ),
    listMilestonePage: () => Effect.succeed({ items: [], nextPage: null }),
    listMetadata: () => Effect.succeed(new Map()),
    statuses: Effect.fn("IssueGitBugHost.statuses")(function* (_, nodeIds) {
      return yield* Effect.forEach(nodeIds, (nodeId) =>
        Effect.gen(function* () {
          const match = /^([^#]+)#([0-9a-f]{7,})$/.exec(nodeId);
          if (!match) return yield* failure("invalid-response", "Invalid git-bug issue identity.");
          const ref = { host: GIT_BUG_HOST, repository: match[1]!, number: numberOf(match[2]!) };
          const bug = yield* locked(ref.repository, (git) => show(git, ref.number));
          return {
            ...ref,
            nodeId,
            state: bug.status,
            stateReason: null,
            blockedBy: [],
            pullRequests: [],
          };
        }),
      );
    }),
    detail: Effect.fn("IssueGitBugHost.detail")(function* (input) {
      const [bug, dates] = yield* locked(input.repository, (git) =>
        show(git, input.number).pipe(
          Effect.flatMap((bug) =>
            git(["bug", "comment", bug.id]).pipe(Effect.map((dates) => [bug, dates] as const)),
          ),
        ),
      );
      const created = new Map(
        Array.from(dates.matchAll(/^Id: ([0-9a-f]+)\nDate: (.+)$/gm), (match) => [
          match[1]!,
          match[2]!,
        ]),
      );
      return {
        repository: { host: GIT_BUG_HOST, repository: input.repository },
        viewer: null,
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
        // No relationships exist to read, so the read is complete (IssueEligibility needs this).
        issue: {
          ...summary(input.repository, bug, bug.comments.length),
          parent: null,
          blockedBy: [],
          relationshipsComplete: true,
        },
        body: bug.comments[0]?.message ?? "",
        comments: bug.comments.slice(1).map((comment) => ({
          author: person(comment.author),
          body: comment.message,
          createdAt: iso(created.get(comment.human_id) ?? bug.edit_time.time),
          url: `${issueUrl(input.repository, input.number)}#${comment.human_id}`,
        })),
        linkedPullRequests: [],
      };
    }),
    readChangeState: (input) =>
      locked(input.repository, (git) => show(git, input.number)).pipe(
        Effect.map((bug) => baseline(input.repository, bug)),
      ),
    createIssue: (input) => {
      let attempted = false;
      return locked(input.repository, (git) =>
        Effect.gen(function* () {
          if (input.milestoneNumber !== null) return yield* unsupported("milestones");
          const marker = `<!-- t3-issue-change:${input.writeKey} -->`;
          if (input.recover !== false) {
            // ponytail: recovery reads every issue; fine for a rare retry, slow past ~1000 issues.
            for (const listed of yield* list(git, "all")) {
              const bug = yield* show(git, numberOf(listed.human_id));
              if (bug.comments[0]?.message.includes(marker)) return baseline(input.repository, bug);
            }
            return yield* new IssueReadError({
              operation: "detail",
              code: "upstream",
              createOutcome: "unresolved",
              message: "The earlier create did not reach git-bug; creation was not retried.",
            });
          }
          attempted = true;
          const number = yield* create(git, input.title, `${input.body}\n\n${marker}`);
          const bug = yield* show(git, number);
          yield* input.onCreated?.(linked(input.repository, bug)) ?? Effect.void;
          return baseline(input.repository, bug);
        }).pipe(
          Effect.mapError(
            (error) =>
              new IssueReadError({
                operation: error.operation,
                code: error.code,
                message: error.message,
                // Once `bug new` ran, the issue may exist even though a later step failed.
                createOutcome:
                  error.createOutcome ??
                  (input.recover !== false || attempted ? "uncertain" : "rejected"),
              }),
          ),
        ),
      );
    },
    updateBody: (input) =>
      locked(input.repository, (git) =>
        Effect.gen(function* () {
          const first = (yield* show(git, input.number)).comments[0]!;
          yield* git(["bug", "comment", "edit", first.id, "--non-interactive", "-m", input.body]);
        }),
      ),
    setMilestone: () => unsupported("milestones"),
    setState: (input) =>
      locked(input.repository, (git) =>
        show(git, input.number).pipe(
          Effect.flatMap((bug) =>
            git(["bug", "status", input.state === "closed" ? "close" : "open", bug.id]),
          ),
        ),
      ).pipe(Effect.asVoid),
    setParent: () => unsupported("sub-issues"),
    setBlockedBy: () => unsupported("blockers"),
    writeManagedComment: (input) =>
      locked(input.issue.repository, (git) =>
        Effect.gen(function* () {
          const body = input.body.includes(input.marker)
            ? input.body
            : `${input.body.trimEnd()}\n\n${input.marker}`;
          const comments = (yield* show(git, input.issue.number)).comments.slice(1);
          const existing =
            (input.operation === "status_sync"
              ? comments.find((row) => row.human_id === input.commentId)
              : undefined) ?? comments.find((row) => row.message.includes(input.marker));
          if (existing !== undefined && input.operation === "closeout_create")
            return { commentId: existing.human_id };
          if (existing !== undefined) {
            yield* git(["bug", "comment", "edit", existing.id, "--non-interactive", "-m", body]);
            return { commentId: existing.human_id };
          }
          return { commentId: (yield* comment(git, input.issue, body)).humanId };
        }),
      ),
    // No live change detection (capabilities.liveChanges is false): the inbox watcher never asks.
    activitySince: () =>
      Effect.succeed({
        issues: { items: [], etag: null, complete: true },
        comments: { items: [], etag: null, complete: true },
        stateChanges: { items: [], etag: null, complete: true },
        eventsAfter: 0,
      }),
    listComments: (ref) =>
      locked(ref.repository, (git) => show(git, ref.number)).pipe(
        Effect.map((bug) => ({
          comments: bug.comments.slice(1).map((row) => ({
            id: numberOf(row.human_id),
            body: row.message,
            html_url: `${issueUrl(ref.repository, ref.number)}#${row.human_id}`,
          })),
          complete: true,
        })),
      ),
    postComment: (ref, body) =>
      locked(ref.repository, (git) => comment(git, ref, body)).pipe(
        Effect.map(({ id, html_url }) => ({ id, html_url })),
      ),
    postIssue: (scope, payload) =>
      locked(scope.repository, (git) =>
        Effect.gen(function* () {
          const number = yield* create(git, payload.title, payload.body);
          if (payload.labels.length > 0)
            yield* git(["bug", "label", "new", (yield* show(git, number)).id, ...payload.labels]);
          return { id: number, number, html_url: issueUrl(scope.repository, number) };
        }),
      ),
    // git-bug labels need no definition before use.
    ensureLabels: () => Effect.void,
    setLabels: (ref, add, remove) =>
      locked(ref.repository, (git) =>
        Effect.gen(function* () {
          const bug = yield* show(git, ref.number);
          const current = new Set(bug.labels ?? []);
          const added = add.filter((label) => !current.has(label));
          const removed = remove.filter((label) => current.has(label));
          if (added.length > 0) yield* git(["bug", "label", "new", bug.id, ...added]);
          if (removed.length > 0) yield* git(["bug", "label", "rm", bug.id, ...removed]);
        }),
      ),
  };
  return host;
});

/**
 * The git-bug host, serving every project whose repository opted in (`git config t3.issues
 * git-bug`). Like Forgejo logins, the opt-in is read at server start: without one, no host is added.
 */
export const discover = Effect.fn("IssueGitBugHost.discover")(function* () {
  const store = yield* Effect.serviceOption(ProjectStoreV2);
  const resolver = yield* Effect.serviceOption(RepositoryIdentityResolver);
  const runner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
  if (Option.isNone(store) || Option.isNone(resolver) || Option.isNone(runner))
    return new Map<string, IssueHost>();
  // ponytail: resolves every project's identity (cached by the resolver) on each git-bug call.
  const checkouts = store.value.list().pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows,
        (row) =>
          resolver.value.resolve(row.workspaceRoot).pipe(
            Effect.map((identity) => {
              const repository = issueRepositoryOf(identity);
              return repository?.host === GIT_BUG_HOST
                ? [{ repository: repository.repository, cwd: row.workspaceRoot }]
                : [];
            }),
          ),
        { concurrency: 8 },
      ),
    ),
    Effect.map((found) => found.flat()),
  );
  if ((yield* checkouts).length === 0) return new Map<string, IssueHost>();
  const host = yield* make(checkouts).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner.value),
  );
  return new Map([[GIT_BUG_HOST, host]]);
});
