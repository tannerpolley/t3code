import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type IssueDetailInput,
  type IssueDetailResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createIssueEnvironmentAtoms } from "./issues.ts";

it.effect("keeps a late issue response on its own issue and environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const firstResult = yield* Deferred.make<IssueDetailResult>();
      const reference = {
        host: "github.com",
        repository: "owner/repo",
        number: 1,
      };
      const response = (number: number, title: string): IssueDetailResult => ({
        repository: { host: reference.host, repository: reference.repository },
        viewer: { accountId: "42", login: "reader" },
        fetchedAt: "2026-09-21T00:00:00Z",
        body: title,
        comments: [],
        linkedPullRequests: [],
        issue: {
          number,
          title,
          url: `https://github.com/owner/repo/issues/${number}`,
          state: "open",
          stateReason: null,
          author: null,
          assignees: [],
          labels: [],
          milestone: null,
          createdAt: "2026-09-21T00:00:00Z",
          updatedAt: "2026-09-21T00:00:00Z",
          commentCount: 0,
        },
      });
      const calls: string[] = [];
      const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
      for (const name of ["first", "second"]) {
        const environmentId = EnvironmentId.make(name);
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: name,
          httpBaseUrl: `https://${name}.example.test`,
          wsBaseUrl: `wss://${name}.example.test`,
        });
        const client = {
          [WS_METHODS.issuesDetail]: (input: IssueDetailInput) =>
            Effect.gen(function* () {
              calls.push(`${name}:${input.number}`);
              if (name === "first" && input.number === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                return yield* Deferred.await(firstResult);
              }
              return response(input.number, `${name} issue ${input.number}`);
            }),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
          initialConfig: Effect.never,
          subscribeServerConfig: () => Stream.empty,
        };
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.of({
            target,
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              desired: true,
              network: "online",
              phase: "connected",
              attempt: 1,
              generation: 1,
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(id)!),
        followStream: (id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(id)!),
      } as EnvironmentRegistry["Service"]);
      const queries = createIssueEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const first = queries.detail({
        environmentId: EnvironmentId.make("first"),
        input: reference,
      });
      const selected = queries.detail({
        environmentId: EnvironmentId.make("first"),
        input: { ...reference, number: 2 },
      });
      const elsewhere = queries.detail({
        environmentId: EnvironmentId.make("second"),
        input: reference,
      });
      const unmount = registry.mount(first);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Deferred.await(firstStarted);
      expect(
        (yield* AtomRegistry.getResult(registry, selected, { suspendOnWaiting: true })).issue.title,
      ).toBe("first issue 2");
      expect(
        (yield* AtomRegistry.getResult(registry, elsewhere, { suspendOnWaiting: true })).issue
          .title,
      ).toBe("second issue 1");
      yield* Deferred.succeed(firstResult, response(1, "Late first issue"));
      expect(
        (yield* AtomRegistry.getResult(registry, first, { suspendOnWaiting: true })).issue.title,
      ).toBe("Late first issue");
      expect(
        (yield* AtomRegistry.getResult(registry, selected, { suspendOnWaiting: true })).issue.title,
      ).toBe("first issue 2");
      expect(calls).toEqual(["first:1", "first:2", "second:1"]);
    }),
  ),
);

it.effect("re-reads an open issue when an agent turn finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("local");
      const turnFinished = yield* PubSub.unbounded<number>();
      const reads: number[] = [];
      const secondRead = yield* Deferred.make<void>();
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "local",
        httpBaseUrl: "https://local.example.test",
        wsBaseUrl: "wss://local.example.test",
      });
      const client = {
        [WS_METHODS.issuesDetail]: (input: IssueDetailInput) =>
          Effect.gen(function* () {
            reads.push(input.number);
            if (reads.length === 2) yield* Deferred.succeed(secondRead, undefined);
            return {
              repository: { host: input.host, repository: input.repository },
              viewer: { accountId: "42", login: "reader" },
              fetchedAt: "2026-09-21T00:00:00Z",
              body: `read ${reads.length}`,
              comments: [],
              linkedPullRequests: [],
              issue: {
                number: input.number,
                title: `read ${reads.length}`,
                url: "https://github.com/owner/repo/issues/1",
                state: "open",
                stateReason: null,
                author: null,
                assignees: [],
                labels: [],
                milestone: null,
                createdAt: "2026-09-21T00:00:00Z",
                updatedAt: "2026-09-21T00:00:00Z",
                commentCount: 0,
              },
            } as IssueDetailResult;
          }),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(turnFinished),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.empty,
      };
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.of({
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const queries = createIssueEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const detail = queries.detail({
        environmentId,
        input: { host: "github.com", repository: "owner/repo", number: 1 },
      });
      const unmount = registry.mount(detail);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).body,
      ).toBe("read 1");

      yield* PubSub.publish(turnFinished, 1);
      yield* Deferred.await(secondRead);
      expect(reads).toEqual([1, 1]);
    }),
  ),
);
