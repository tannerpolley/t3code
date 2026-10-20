import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  IssueWorkError,
  IssueReadError,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { issueQueueRequestAfterResult } from "./issueQueue.logic";

const request = { queued: false, id: CommandId.make("queue-request") };

describe("queue request retries", () => {
  it.each([
    new IssueWorkError({ code: "repository-owner-conflict", message: "Ownership changed. Retry." }),
    new IssueWorkError({ code: "orchestration-error", message: "Previously rejected." }),
    new IssueReadError({
      code: "inaccessible",
      operation: "detail",
      message: "Could not read the issue.",
    }),
    new EnvironmentAuthorizationError({
      message: "Permission denied.",
      requiredScope: "orchestration:operate",
    }),
  ])("releases a definitively rejected id for the next click (%s)", (error) => {
    expect(
      issueQueueRequestAfterResult(request, AsyncResult.failure(Cause.fail(error))),
    ).toBeNull();
  });

  it("retains the same id after an uncertain transport failure, then releases it on success", () => {
    const retry = issueQueueRequestAfterResult(
      request,
      AsyncResult.failure(Cause.fail(new Error("Socket closed before the response"))),
    );
    expect(retry).toBe(request);
    expect(issueQueueRequestAfterResult(retry!, AsyncResult.success({}))).toBeNull();
  });
});
