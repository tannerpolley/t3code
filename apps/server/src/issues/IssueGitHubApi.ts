import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

export type GitHubApiError = GitHubRequestPolicy.GitHubApiError;

const Response = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decode = Schema.decodeEffect(Schema.fromJsonString(Response));

// Fork issue queries return their envelope so optional metadata can inspect per-field errors.
export class GitHubApi extends Context.Service<
  GitHubApi,
  GitHubRest.GitHubRest["Service"] & {
    readonly graphql: (input: {
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
      readonly maxResponseBytes?: number;
      readonly acceptPartialData?: boolean;
    }) => Effect.Effect<string, GitHubApiError>;
  }
>()("t3/issues/IssueGitHubApi/GitHubApi") {}

const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const http = yield* HttpClient.HttpClient;
  return GitHubApi.of({
    ...rest,
    graphql: Effect.fn("GitHubApi.graphql")(function* (input) {
      const host = GitHubRequestPolicy.normalizeHost(input.host);
      return yield* policy.request(
        {
          host,
          operation: input.operation,
          resource: "graphql",
          allowReserve: yield* SourceControlRateLimit.Interactive,
        },
        (headers) =>
          Effect.gen(function* () {
            const request = yield* HttpClientRequest.post(
              GitHubRequestPolicy.gitHubApiUrls(host).graphql,
            ).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJson({
                query: input.query,
                variables: input.variables ?? {},
              }),
            );
            const answer = yield* http
              .execute(request)
              .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
            const collected = yield* collectUint8StreamText({
              stream: answer.stream,
              maxBytes: input.maxResponseBytes ?? 8 * 1024 * 1024,
            }).pipe(
              // Body-less refusals still need status classification by the request policy.
              Effect.catchIf(
                (error) => error.reason._tag === "EmptyBodyError",
                () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
              ),
            );
            const meta = { status: answer.status, headers: answer.headers };
            if (collected.truncated) return { ...meta, _tag: "Failed" as const };
            const decoded = yield* decode(collected.text).pipe(Effect.orElseSucceed(() => null));
            const errors = decoded?.errors;
            if (
              GitHubRequestPolicy.isRateLimited({
                ...meta,
                body: collected.text,
                ...(errors === undefined ? {} : { graphqlErrors: errors }),
              })
            )
              return { ...meta, _tag: "RateLimited" as const };
            if (answer.status === 401) return { ...meta, _tag: "Unauthorized" as const };
            const partial =
              input.acceptPartialData === true &&
              decoded?.data != null &&
              !errors?.some((error) => error.type === "INSUFFICIENT_SCOPES");
            if (
              answer.status >= 200 &&
              answer.status < 300 &&
              decoded !== null &&
              (!errors?.length || partial)
            )
              return { ...meta, _tag: "Ok" as const, value: collected.text };
            if (
              answer.status === 404 ||
              (errors !== undefined &&
                errors.length > 0 &&
                errors.every((error) => error.type === "NOT_FOUND"))
            )
              return { ...meta, _tag: "NotFound" as const };
            return {
              ...meta,
              _tag: "Failed" as const,
              messages: errors?.flatMap((error) =>
                error.message === undefined ? [] : [error.message],
              ),
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRequestPolicy.GitHubApiRequestError({
                  host,
                  operation: input.operation,
                  cause,
                }),
            ),
          ),
      );
    }),
  });
});

export const layer = Layer.effect(GitHubApi, make);
