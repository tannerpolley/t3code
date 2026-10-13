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
        name: Schema.optional(Schema.String),
        options: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
      }),
    ),
  ),
});
const FieldValues = Schema.Struct({
  nodes: Schema.NullOr(Schema.Array(Schema.NullOr(FieldValue))),
  pageInfo: PageInfo,
});
const ProjectItem = Schema.Struct({
  id: Schema.String,
  project: Schema.NullOr(Schema.Struct({ id: Schema.String, title: Schema.String })),
  fieldValues: Schema.NullOr(FieldValues),
});
const Response = Schema.Struct({
  data: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Union([
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
        ProjectItem,
      ]),
    ),
  ),
});
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));

type IssueProject = NonNullable<IssueSummary["projects"]>[number];
type ProjectPage =
  | { readonly kind: "issue"; readonly number: number; readonly cursor: string | null }
  | {
      readonly kind: "item";
      readonly number: number;
      readonly id: string;
      readonly cursor: string;
    };

const FIELD_VALUES = `fieldValues(first: 20, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on ProjectV2ItemFieldSingleSelectValue {
      name optionId
      field { ... on ProjectV2SingleSelectField { name options { id } } }
    }
  }
}`;
const ITEM_FIELDS = `id project { id title } ${FIELD_VALUES}`;

/** Normalizes only the two named single-select fields, retaining the Project's option order. */
function mergeProjectFields(
  project: IssueProject,
  values: Schema.Schema.Type<typeof FieldValues> | null,
): IssueProject {
  let { status, priority } = project;
  for (const value of values?.nodes ?? []) {
    if (value?.__typename !== "ProjectV2ItemFieldSingleSelectValue" || !value.name?.trim()) {
      continue;
    }
    const field = value.field?.name?.trim().toLowerCase();
    if (field === "status") status = value.name;
    if (field === "priority") {
      const rank = value.field?.options?.findIndex((option) => option.id === value.optionId) ?? -1;
      priority = { name: value.name, rank: rank < 0 ? null : rank };
    }
  }
  return { ...project, status, priority };
}

/** Optional metadata read inside IssueService's verified credential, batched across each list page. */
export const readIssueProjects = Effect.fn("IssueService.readIssueProjects")(
  function* (scope: IssueRepositoryRef, numbers: readonly number[]) {
    const api = yield* GitHubApi.GitHubApi;
    const projects = new Map<number, Map<string, IssueProject>>();
    const pending: ProjectPage[] = numbers.map((number) => ({
      kind: "issue",
      number,
      cursor: null,
    }));
    const [owner, name] = scope.repository.split("/");
    while (pending.length > 0) {
      // 100 issues × 20 items × 20 values stays below GitHub's 500,000-node query limit.
      const batch = pending.splice(0, 100);
      const variables: Record<string, string | number | null> = { owner: owner!, name: name! };
      const declarations = ["$owner: String!", "$name: String!"];
      const selections = batch.map((page, index) => {
        declarations.push(`$cursor${index}: String`);
        variables[`cursor${index}`] = page.cursor;
        if (page.kind === "item") {
          declarations.push(`$id${index}: ID!`);
          variables[`id${index}`] = page.id;
          return `p${index}: node(id: $id${index}) {
          ... on ProjectV2Item { ${ITEM_FIELDS.replaceAll("$cursor", `$cursor${index}`)} }
        }`;
        }
        declarations.push(`$number${index}: Int!`);
        variables[`number${index}`] = page.number;
        return `p${index}: repository(owner: $owner, name: $name) {
        issue(number: $number${index}) {
          projectItems(first: 20, after: $cursor${index}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ITEM_FIELDS.replaceAll("$cursor", "null")} }
          }
        }
      }`;
      });
      // Item-only follow-up batches do not reference the repository variables.
      const queryDeclarations = batch.some((page) => page.kind === "issue")
        ? declarations
        : declarations.slice(2);
      const body = yield* api.graphql({
        host: scope.host,
        operation: "issues.projects",
        query: `query(${queryDeclarations.join(", ")}) { ${selections.join("\n")} }`,
        variables,
        maxResponseBytes: 4 * 1024 * 1024,
      });
      const response = yield* decodeResponse(body);
      for (const [index, page] of batch.entries()) {
        const result = response.data[`p${index}`];
        if (result === null || result === undefined) continue;
        const connection = "issue" in result ? result.issue?.projectItems : null;
        if (connection?.pageInfo.hasNextPage && connection.pageInfo.endCursor !== null) {
          if (connection.pageInfo.endCursor === page.cursor)
            return new Map<number, IssueProject[]>();
          pending.push({
            kind: "issue",
            number: page.number,
            cursor: connection.pageInfo.endCursor,
          });
        }
        const items = "issue" in result ? (connection?.nodes ?? []) : [result];
        for (const item of items) {
          if (!item?.project?.id || !item.project.title.trim()) continue;
          const issueProjects = projects.get(page.number) ?? new Map<string, IssueProject>();
          const previous = issueProjects.get(item.project.id) ?? {
            ...item.project,
            status: null,
            priority: null,
          };
          issueProjects.set(item.project.id, mergeProjectFields(previous, item.fieldValues));
          projects.set(page.number, issueProjects);
          const info = item.fieldValues?.pageInfo;
          if (info?.hasNextPage && info.endCursor !== null) {
            if (page.kind === "item" && info.endCursor === page.cursor) {
              return new Map<number, IssueProject[]>();
            }
            pending.push({
              kind: "item",
              number: page.number,
              id: item.id,
              cursor: info.endCursor,
            });
          }
        }
      }
    }
    return new Map([...projects].map(([number, values]) => [number, [...values.values()]]));
  },
  // Project scope, access and availability must never prevent the underlying issue list from loading.
  Effect.orElseSucceed(() => new Map<number, IssueProject[]>()),
);
