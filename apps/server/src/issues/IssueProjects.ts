import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueRepositoryRef, IssueSummary, IssueRef } from "@t3tools/contracts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const FieldValue = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  optionId: Schema.optional(Schema.NullOr(Schema.String)),
  field: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        options: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
      }),
    ),
  ),
});
const ProjectItem = Schema.Struct({
  project: Schema.NullOr(Schema.Struct({ id: Schema.String, title: Schema.String })),
  status: Schema.NullOr(FieldValue),
  priority: Schema.NullOr(FieldValue),
});
const RelatedIssue = Schema.Struct({
  number: Schema.Int,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});
const Blockers = Schema.Struct({
  nodes: Schema.Array(Schema.NullOr(RelatedIssue)),
  pageInfo: PageInfo,
});
const PullRequestRef = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Int),
  repository: Schema.optional(Schema.Struct({ nameWithOwner: Schema.String })),
});
const Response = Schema.Struct({
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
      }),
    ),
  ),
  data: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            parent: Schema.optional(Schema.NullOr(RelatedIssue)),
            blockedBy: Schema.optional(Schema.NullOr(Blockers)),
            closedByPullRequestsReferences: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.Array(Schema.NullOr(PullRequestRef)),
                  pageInfo: Schema.optional(PageInfo),
                }),
              ),
            ),
            timelineItems: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.Array(
                    Schema.NullOr(
                      Schema.Struct({
                        source: Schema.optional(Schema.NullOr(PullRequestRef)),
                      }),
                    ),
                  ),
                  pageInfo: Schema.optional(
                    Schema.Struct({
                      hasPreviousPage: Schema.Boolean,
                      startCursor: Schema.NullOr(Schema.String),
                    }),
                  ),
                }),
              ),
            ),
            projectItems: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  nodes: Schema.NullOr(Schema.Array(Schema.NullOr(ProjectItem))),
                  pageInfo: PageInfo,
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
});
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));

type IssueProject = NonNullable<IssueSummary["projects"]>[number];
type ListMetadata = Pick<
  IssueSummary,
  "projects" | "blockedBy" | "parent" | "relationshipsComplete" | "pullRequestRefs"
>;
type MetadataPage = {
  readonly number: number;
  readonly cursor: string | null | undefined;
  readonly blockerCursor: string | null | undefined;
  readonly pullRequestCursor: string | null | undefined;
  readonly timelineCursor: string | null | undefined;
};

const ITEM_FIELDS = `project { id title }
  status: fieldValueByName(name: "Status") {
    __typename
    ... on ProjectV2ItemFieldSingleSelectValue { name }
  }
  priority: fieldValueByName(name: "Priority") {
    __typename
    ... on ProjectV2ItemFieldSingleSelectValue {
      name optionId
      field { ... on ProjectV2SingleSelectField { options { id name } } }
    }
  }`;

/** Optional metadata read inside IssueService's verified credential, batched across each list page. */
export const readIssueListMetadata = Effect.fn("IssueService.readIssueListMetadata")(
  function* (scope: IssueRepositoryRef, numbers: readonly number[]) {
    const api = yield* GitHubApi.GitHubApi;
    const projects = new Map<number, Map<string, IssueProject>>();
    const metadata = new Map<number, ListMetadata>();
    const pullRequests = new Map<number, Map<string, IssueRef>>();
    const blockers = new Map<number, Map<string, NonNullable<IssueSummary["blockedBy"]>[number]>>();
    const unavailable = new Set<number>();
    const pending: MetadataPage[] = numbers.map((number) => ({
      number,
      cursor: null,
      blockerCursor: null,
      pullRequestCursor: null,
      timelineCursor: null,
    }));
    const [owner, name] = scope.repository.split("/");
    while (pending.length > 0) {
      const batch = pending.splice(0, 100);
      const variables: Record<string, string | number | null> = { owner: owner!, name: name! };
      const declarations = ["$owner: String!", "$name: String!"];
      const selections = batch.map((page, index) => {
        declarations.push(`$number${index}: Int!`);
        if (page.cursor !== undefined) {
          declarations.push(`$cursor${index}: String`);
          variables[`cursor${index}`] = page.cursor;
        }
        if (page.blockerCursor !== undefined) {
          declarations.push(`$blocker${index}: String`);
          variables[`blocker${index}`] = page.blockerCursor;
        }
        if (page.pullRequestCursor !== undefined) {
          declarations.push(`$pullRequest${index}: String`);
          variables[`pullRequest${index}`] = page.pullRequestCursor;
        }
        if (page.timelineCursor !== undefined) {
          declarations.push(`$timeline${index}: String`);
          variables[`timeline${index}`] = page.timelineCursor;
        }
        variables[`number${index}`] = page.number;
        return `p${index}: repository(owner: $owner, name: $name) {
        issue(number: $number${index}) {
          parent { number state repository { nameWithOwner } }
          ${
            page.blockerCursor === undefined
              ? ""
              : `blockedBy(first: 100, after: $blocker${index}) {
            nodes { number state repository { nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }`
          }
          ${
            page.pullRequestCursor === undefined
              ? ""
              : `closedByPullRequestsReferences(first: 100, after: $pullRequest${index}, includeClosedPrs: true) {
            nodes { number repository { nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }`
          }
          ${
            page.timelineCursor === undefined
              ? ""
              : `timelineItems(last: 100, before: $timeline${index}, itemTypes: [CROSS_REFERENCED_EVENT]) {
            nodes { ... on CrossReferencedEvent {
              source { __typename ... on PullRequest { number repository { nameWithOwner } } }
            } }
            pageInfo { hasPreviousPage startCursor }
          }`
          }
          ${
            page.cursor === undefined
              ? ""
              : `projectItems(first: 20, after: $cursor${index}, includeArchived: false) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ITEM_FIELDS} }
          }`
          }
        }
      }`;
      });
      const body = yield* api.graphql({
        host: scope.host,
        operation: "issues.projects",
        query: `query(${declarations.join(", ")}) { ${selections.join("\n")} }`,
        variables,
        maxResponseBytes: 4 * 1024 * 1024,
        acceptPartialData: true,
      });
      const response = yield* decodeResponse(body);
      const failedFields = (alias: string, field: string) =>
        response.errors?.some(
          (error) =>
            error.path === undefined ||
            (error.path[0] === alias && (error.path.length < 3 || error.path[2] === field)),
        ) ?? false;
      for (const [index, page] of batch.entries()) {
        const alias = `p${index}`;
        const node = response.data[alias]?.issue;
        if (failedFields(alias, "projectItems")) {
          unavailable.add(page.number);
          projects.delete(page.number);
        }
        const connection = unavailable.has(page.number) ? null : node?.projectItems;
        const blocked = node?.blockedBy;
        const ref = (number: number, repository: string): IssueRef => ({
          host: scope.host,
          repository,
          number,
        });
        const issueBlockers = blockers.get(page.number) ?? new Map();
        for (const blocker of blocked?.nodes ?? []) {
          if (blocker === null) continue;
          const identity = ref(blocker.number, blocker.repository.nameWithOwner);
          issueBlockers.set(`${identity.repository.toLowerCase()}#${identity.number}`, {
            ...identity,
            state: blocker.state === "OPEN" ? "open" : "closed",
          });
        }
        blockers.set(page.number, issueBlockers);
        const prs = pullRequests.get(page.number) ?? new Map<string, IssueRef>();
        for (const pr of [
          ...(node?.closedByPullRequestsReferences?.nodes ?? []),
          ...(node?.timelineItems?.nodes ?? []).map((event) =>
            event?.source?.__typename === "PullRequest" ? event.source : null,
          ),
        ]) {
          if (pr?.number === undefined || pr.repository === undefined) continue;
          const identity = ref(pr.number, pr.repository.nameWithOwner);
          prs.set(`${identity.repository.toLowerCase()}#${identity.number}`, identity);
        }
        pullRequests.set(page.number, prs);
        const previous = metadata.get(page.number);
        metadata.set(page.number, {
          blockedBy: [...issueBlockers.values()],
          parent:
            node?.parent == null
              ? null
              : ref(node.parent.number, node.parent.repository.nameWithOwner),
          relationshipsComplete:
            previous?.relationshipsComplete !== false &&
            node?.parent !== undefined &&
            (page.blockerCursor === undefined ||
              (blocked != null && blocked.nodes.every((node) => node !== null))) &&
            !failedFields(alias, "blockedBy") &&
            !failedFields(alias, "parent"),
          pullRequestRefs: [...prs.values()],
        });
        const nextProject = connection?.pageInfo.hasNextPage
          ? connection.pageInfo.endCursor
          : undefined;
        const nextBlocker = blocked?.pageInfo.hasNextPage ? blocked.pageInfo.endCursor : undefined;
        const closing = node?.closedByPullRequestsReferences?.pageInfo;
        const timeline = node?.timelineItems?.pageInfo;
        const nextPullRequest =
          closing?.hasNextPage &&
          closing.endCursor !== null &&
          closing.endCursor !== page.pullRequestCursor
            ? closing.endCursor
            : undefined;
        const nextTimeline =
          timeline?.hasPreviousPage &&
          timeline.startCursor !== null &&
          timeline.startCursor !== page.timelineCursor
            ? timeline.startCursor
            : undefined;
        if (
          (connection?.pageInfo.hasNextPage &&
            (nextProject === null || nextProject === page.cursor)) ||
          (blocked?.pageInfo.hasNextPage &&
            (nextBlocker === null || nextBlocker === page.blockerCursor))
        ) {
          metadata.set(page.number, { ...metadata.get(page.number), relationshipsComplete: false });
          continue;
        }
        if (
          nextProject !== undefined ||
          nextBlocker !== undefined ||
          nextPullRequest !== undefined ||
          nextTimeline !== undefined
        ) {
          pending.push({
            number: page.number,
            cursor: nextProject,
            blockerCursor: nextBlocker,
            pullRequestCursor: nextPullRequest,
            timelineCursor: nextTimeline,
          });
        }
        for (const item of connection?.nodes ?? []) {
          if (!item?.project?.id || !item.project.title.trim()) continue;
          const issueProjects = projects.get(page.number) ?? new Map<string, IssueProject>();
          const status =
            item.status?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
            item.status.name?.trim()
              ? item.status.name
              : null;
          const value = item.priority;
          const rank =
            value?.field?.options?.findIndex((option) => option.id === value.optionId) ?? -1;
          const priority =
            value?.__typename === "ProjectV2ItemFieldSingleSelectValue" && value.name?.trim()
              ? { name: value.name, rank: rank < 0 ? null : rank }
              : null;
          issueProjects.set(item.project.id, { ...item.project, status, priority });
          projects.set(page.number, issueProjects);
        }
      }
    }
    return new Map(
      numbers.map((number) => [
        number,
        {
          ...metadata.get(number),
          projects: [...(projects.get(number)?.values() ?? [])],
        } satisfies ListMetadata,
      ]),
    );
  },
  // Optional metadata must never prevent the underlying issue list from loading.
  Effect.orElseSucceed(() => new Map<number, ListMetadata>()),
);
