import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as IssueService from "./IssueService.ts";

// A linked pull request's snapshot turns merged when the pull request sync or watch reads it.
const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const issues = yield* IssueService.IssueService;
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "thread.pull-request-link-updated" &&
      event.payload.snapshot?.state === "merged"
        ? issues
            .closeIssuesFixedBy({
              host: event.payload.host,
              repository: event.payload.repository,
              number: event.payload.number,
            })
            .pipe(
              Effect.catchTags({
                IssueReadError: (error) =>
                  Effect.logWarning("closing the issues a merged pull request names failed", {
                    pullRequest: event.payload.url,
                    reason: error.message,
                  }),
              }),
            )
        : Effect.void,
    ),
  );
});

export const layer = Layer.effectDiscard(make);
