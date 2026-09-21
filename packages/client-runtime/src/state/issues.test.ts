import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type IssueDetailInput,
  type IssueDetailResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
        projectId: ProjectId.make("project"),
        host: "github.com",
        repository: "owner/repo",
        number: 1,
      };
      const response = (number: number, title: string): IssueDetailResult => ({
        repository: reference,
        projectTitle: "Project",
        workspaceRoot: "/workspace",
        viewer: { accountId: "42", login: "reader" },
        fetchedAt: "2026-09-21T00:00:00Z",
        body: title,
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
