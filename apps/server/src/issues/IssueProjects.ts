import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueRepositoryRef, IssueSummary } from "@t3tools/contracts";
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
            projectItems: Schema.NullOr(
              Schema.Struct({
                nodes: Schema.NullOr(Schema.Array(Schema.NullOr(ProjectItem))),
                pageInfo: PageInfo,
              }),
            ),
          }),
        ),
      }),
    ),
  ),
});
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));

type IssueProject = NonNullable<IssueSummary["projects"]>[number];
type ProjectPage = { readonly number: number; readonly cursor: string | null };

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
export const readIssueProjects = Effect.fn("IssueService.readIssueProjects")(
  function* (scope: IssueRepositoryRef, numbers: readonly number[]) {
    const api = yield* GitHubApi.GitHubApi;
    const projects = new Map<number, Map<string, IssueProject>>();
    const unavailable = new Set<number>();
    const pending: ProjectPage[] = numbers.map((number) => ({ number, cursor: null }));
    const [owner, name] = scope.repository.split("/");
    while (pending.length > 0) {
      const batch = pending.splice(0, 100);
      const variables: Record<string, string | number | null> = { owner: owner!, name: name! };
      const declarations = ["$owner: String!", "$name: String!"];
      const selections = batch.map((page, index) => {
        declarations.push(`$cursor${index}: String`, `$number${index}: Int!`);
        variables[`cursor${index}`] = page.cursor;
        variables[`number${index}`] = page.number;
        return `p${index}: repository(owner: $owner, name: $name) {
        issue(number: $number${index}) {
          projectItems(first: 20, after: $cursor${index}, includeArchived: false) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ITEM_FIELDS} }
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
      const failedAliases = new Set(response.errors?.map((error) => error.path?.[0]));
      for (const [index, page] of batch.entries()) {
        if (failedAliases.has(`p${index}`)) {
          unavailable.add(page.number);
          projects.delete(page.number);
        }
        if (unavailable.has(page.number)) continue;
        const connection = response.data[`p${index}`]?.issue?.projectItems;
        if (connection?.pageInfo.hasNextPage && connection.pageInfo.endCursor !== null) {
          if (connection.pageInfo.endCursor === page.cursor)
            return new Map<number, IssueProject[]>();
          pending.push({ number: page.number, cursor: connection.pageInfo.endCursor });
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
    return new Map([...projects].map(([number, values]) => [number, [...values.values()]]));
  },
  // Project scope, access and availability must never prevent the underlying issue list from loading.
  Effect.orElseSucceed(() => new Map<number, IssueProject[]>()),
);
