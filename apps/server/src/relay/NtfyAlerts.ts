import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSettings from "../serverSettings.ts";

interface NtfyDestination {
  readonly baseUrl: string;
  readonly topic: string;
}

const alertSummary: Partial<Record<RelayAgentActivityState["phase"], string>> = {
  waiting_for_approval: "needs your approval",
  waiting_for_input: "needs your answer",
  completed: "finished",
  failed: "failed",
};

class NtfyDeliveryError extends Schema.TaggedError<NtfyDeliveryError>()("NtfyDeliveryError", {}) {
  override get message() {
    return "Could not publish the thread alert to ntfy.";
  }
}

export class NtfyAlerts extends Context.Service<
  NtfyAlerts,
  {
    readonly destination: Effect.Effect<NtfyDestination | null>;
    readonly send: (
      destination: NtfyDestination,
      state: RelayAgentActivityState,
      delegatedRole: string | undefined,
    ) => Effect.Effect<void, NtfyDeliveryError>;
  }
>()("t3/relay/NtfyAlerts") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const destination = settings.getSettings.pipe(
    Effect.map(({ notificationPresencePeer, notificationNtfyServerUrl, notificationNtfyTopic }) =>
      notificationPresencePeer && notificationNtfyTopic
        ? { baseUrl: notificationNtfyServerUrl, topic: notificationNtfyTopic }
        : null,
    ),
    Effect.orElseSucceed(() => null),
  );

  const send = Effect.fn("NtfyAlerts.send")(function* (
    destination: NtfyDestination,
    state: RelayAgentActivityState,
    delegatedRole: string | undefined,
  ) {
    const summary = alertSummary[state.phase];
    if (!summary) return;
    const project = state.projectTitle.replace(/\s+/gu, " ").slice(0, 120);
    const thread = (delegatedRole ?? state.threadTitle).replace(/\s+/gu, " ").slice(0, 120);
    const url = `${destination.baseUrl.replace(/\/+$/u, "")}/${destination.topic}`;
    yield* http
      .execute(
        HttpClientRequest.post(url, {
          headers: {
            title: "T3 Code",
            click: `t3code:/${state.deepLink}`,
          },
        }).pipe(
          HttpClientRequest.bodyText(
            `${project} / ${thread} ${summary}.`,
            "text/plain; charset=utf-8",
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.asVoid,
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.withTracerEnabled(false),
        Effect.timeout("5 seconds"),
        // HTTP failures carry the request URL, whose final segment is the subscription secret.
        Effect.mapError(() => new NtfyDeliveryError({})),
      );
  });
  return NtfyAlerts.of({ destination, send });
});

export const layer = Layer.effect(NtfyAlerts, make);
