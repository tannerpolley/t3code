import {
  type CommandId,
  EnvironmentAuthorizationError,
  IssueChangeError,
  IssueReadError,
  IssueWorkError,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type IssueQueueRequest = { queued: boolean; id: CommandId };
const isServerRejection = Schema.is(
  Schema.Union([IssueReadError, IssueWorkError, IssueChangeError, EnvironmentAuthorizationError]),
);

export function issueQueueRequestAfterResult(
  request: IssueQueueRequest,
  result: AtomCommandResult<unknown, unknown>,
): IssueQueueRequest | null {
  if (result._tag === "Success") return null;
  const failure = Cause.findErrorOption(result.cause);
  // Reuse the id only while transport or client failures leave acceptance uncertain.
  return Option.isSome(failure) && isServerRejection(failure.value) ? null : request;
}
