import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";

import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const brokerDependencies = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  ServerSettings.layerTest(settings).pipe(Layer.provideMerge(NodeServices.layer));
const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(brokerDependencies()));

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void = () => {},
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

it.effect.each([
  { name: "heals a stuck reused tab once, then retries", limits: true, reuse: true },
  { name: "returns the timeout when agent browser tab limits are off", limits: false, reuse: true },
  { name: "does not retry an open that was creating a new tab", limits: true, reuse: false },
])("timed-out open: $name", ({ limits, reuse }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.make.pipe(
        Effect.provide(brokerDependencies({ agentBrowserTabLimits: limits })),
      );
      const stuckTab = PreviewTabId.make("tab-stuck");
      // The session's host answers its first open, then stops answering.
      const stuckReceived = yield* Deferred.make<void>();
      let stuckRequests = 0;
      yield* Stream.runForEach(
        requestsFrom(yield* broker.connect(makeHost({ clientId: "stuck" }))),
        (request) =>
          stuckRequests++ === 0
            ? broker.respond({
                clientId: "stuck",
                connectionId: request.connectionId,
                requestId: request.requestId,
                ok: true,
                result: { tabId: stuckTab },
              })
            : Deferred.succeed(stuckReceived, undefined),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.invoke({ scope, operation: "open", input: {} });

      const healthyRequests: RoutedRequest[] = [];
      yield* Stream.runForEach(
        requestsFrom(yield* broker.connect(makeHost({ clientId: "healthy" }))),
        (request) => {
          healthyRequests.push(request);
          return broker.respond({
            clientId: "healthy",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: { tabId: request.tabId },
          });
        },
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const opened = yield* broker
        .invoke({
          scope,
          operation: "open",
          input: { url: "http://localhost:8791/", reuseExistingTab: reuse },
        })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(stuckReceived);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(16_000);
      const result = yield* Fiber.join(opened);

      if (limits && reuse) {
        expect(result._tag).toBe("Success");
        expect(
          healthyRequests.map(({ operation, input, tabId }) => ({ operation, input, tabId })),
        ).toEqual([
          {
            operation: "navigate",
            input: { reload: "bypassCache", readiness: "none" },
            tabId: stuckTab,
          },
          {
            operation: "open",
            input: { url: "http://localhost:8791/", reuseExistingTab: true },
            tabId: stuckTab,
          },
        ]);
      } else {
        expect(result._tag === "Failure" && result.failure._tag).toBe(
          "PreviewAutomationTimeoutError",
        );
        expect(healthyRequests).toEqual([]);
      }
    }),
  ),
);

it.effect("stops after the retry of a timed-out open also times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const tabId = PreviewTabId.make("tab-stuck");
      const firstReceived = yield* Deferred.make<void>();
      const retryReceived = yield* Deferred.make<void>();
      const requests: RoutedRequest[] = [];
      yield* Stream.runForEach(
        requestsFrom(yield* broker.connect(makeHost({ clientId: "stuck" }))),
        (request) => {
          requests.push(request);
          return Deferred.succeed(firstReceived, undefined);
        },
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const opened = yield* broker
        .invoke<void>({ scope, tabId, operation: "open", input: { url: "http://localhost:8791/" } })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(firstReceived);

      yield* Stream.runForEach(
        requestsFrom(yield* broker.connect(makeHost({ clientId: "healthy" }))),
        (request) => {
          requests.push(request);
          return request.operation === "navigate"
            ? broker.respond({
                clientId: "healthy",
                connectionId: request.connectionId,
                requestId: request.requestId,
                ok: true,
                result: { tabId },
              })
            : Deferred.succeed(retryReceived, undefined);
        },
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(16_000);
      yield* Deferred.await(retryReceived);
      yield* TestClock.adjust(16_000);
      expect(yield* Fiber.join(opened)).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        operation: "open",
        requestId: requests[2]!.requestId,
      });
      expect(requests.map(({ operation, input, tabId }) => ({ operation, input, tabId }))).toEqual([
        { operation: "open", input: { url: "http://localhost:8791/" }, tabId },
        { operation: "navigate", input: { reload: "bypassCache", readiness: "none" }, tabId },
        { operation: "open", input: { url: "http://localhost:8791/" }, tabId },
      ]);
    }),
  ),
);

it.effect("recovers from a host-reported navigation timeout on the same connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const tabId = PreviewTabId.make("tab-navigation-timeout");
      const requests: RoutedRequest[] = [];
      yield* Stream.runForEach(requestsFrom(yield* broker.connect(makeHost())), (request) => {
        requests.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ...(requests.length === 1
            ? {
                ok: false,
                error: { _tag: "PreviewAutomationTimeoutError", message: "Navigation timed out" },
              }
            : { ok: true, result: { tabId } }),
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const input = { url: "http://localhost:8791/" };
      expect(yield* broker.invoke({ scope, tabId, operation: "navigate", input })).toEqual({
        tabId,
      });
      expect(requests.map(({ operation, input, tabId }) => ({ operation, input, tabId }))).toEqual([
        { operation: "navigate", input, tabId },
        { operation: "navigate", input: { reload: "bypassCache", readiness: "none" }, tabId },
        { operation: "navigate", input, tabId },
      ]);
      expect(new Set(requests.map((request) => request.connectionId)).size).toBe(1);
    }),
  ),
);
