import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  WS_METHODS,
  type IssueStatusBatchInput,
  type IssueDetailInput,
  type RepositoryIssueListInput,
  type RepositoryIssueListResult,
  type IssueDetailResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

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
import { createRepositoryIssueEnvironmentAtoms } from "./repositoryIssues.ts";

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
          [WS_METHODS.issueWorkDetail]: (input: IssueDetailInput) =>
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
          inboundFrames: Effect.succeed(0),
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
      const queries = createRepositoryIssueEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
        () => Atom.make(null),
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

const workThread = (overrides: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make("worker"),
    status: "idle",
    activeRunId: null,
    latestRunId: RunId.make("run-1"),
    updatedAt: "2026-10-20T00:00:00Z",
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;
const shellSnapshot = (threads: OrchestrationV2ThreadShell[]) =>
  ({
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    archivedThreads: [],
    threads,
  }) satisfies OrchestrationV2ShellSnapshot;

it.effect(
  "issue reads follow live work and inbox activity, not turn-finished refreshes or a timer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("local");
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const reads: string[] = [];
        const refreshModes: boolean[] = [];
        const inbox = yield* SubscriptionRef.make(0);
        const turnFinished = yield* SubscriptionRef.make(0);
        const shells = Atom.make<OrchestrationV2ShellSnapshot | null>(
          shellSnapshot([workThread()]),
        );
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "local",
          httpBaseUrl: "https://local.example.test",
          wsBaseUrl: "wss://local.example.test",
        });
        const client = {
          [WS_METHODS.issuesInboxSubscribeUnread]: () => SubscriptionRef.changes(inbox),
          [WS_METHODS.pullRequestsSubscribeRefreshes]: () => SubscriptionRef.changes(turnFinished),
          [WS_METHODS.issueWorkDetail]: (input: IssueDetailInput) =>
            Effect.sync(() => {
              reads.push("detail");
              refreshModes.push(input.refresh!);
              return {} as IssueDetailResult;
            }),
          [WS_METHODS.issueWorkRoadmap]: (input: RepositoryIssueListInput) =>
            Effect.sync(() => {
              reads.push(input.repository);
              refreshModes.push(input.refresh!);
              return {} as RepositoryIssueListResult;
            }),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          ready: Effect.void,
          probe: Effect.void,
          inboundFrames: Effect.succeed(0),
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
        const queries = createRepositoryIssueEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
          () => shells,
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const input = { host: "github.com", repository: "owner/repo" };
        const atoms: Array<Atom.Atom<AsyncResult.AsyncResult<unknown, Error>>> = [
          queries.list({ environmentId, input }),
          queries.detail({ environmentId, input: { ...input, number: 1 } }),
        ];
        for (const atom of atoms) {
          const unmount = registry.mount(atom);
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
        }
        const settle = Effect.gen(function* () {
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
          for (const atom of atoms)
            yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        });
        yield* settle;
        expect(reads).toEqual(["owner/repo", "detail"]);

        yield* SubscriptionRef.set(turnFinished, 1);
        yield* Effect.sync(() =>
          registry.set(shells, shellSnapshot([workThread({ updatedAt: "2026-10-21T00:00:00Z" })])),
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10 * 60_000));
        yield* settle;
        expect(reads).toHaveLength(2);

        yield* Effect.sync(() =>
          registry.set(shells, shellSnapshot([workThread({ status: "running" })])),
        );
        yield* settle;
        expect(reads).toEqual(["owner/repo", "detail", "owner/repo", "detail"]);
        yield* SubscriptionRef.set(inbox, 1);
        yield* settle;
        expect(reads).toHaveLength(6);
        expect(refreshModes).toEqual(Array.from({ length: 6 }, () => false));

        for (const atom of atoms) registry.refresh(atom);
        yield* settle;
        expect(refreshModes.slice(6)).toEqual([true, true]);
      }),
    ),
);

it.effect("coalesces repository consumers and refreshes once on inbox activity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("local");
      const inbox = yield* SubscriptionRef.make(0);
      const started = yield* Deferred.make<void>();
      const refreshed = yield* Deferred.make<void>();
      const batchRefreshed = yield* Deferred.make<void>();
      let listReads = 0;
      let batchReads = 0;
      const batchRefreshModes: boolean[] = [];
      const response = yield* Deferred.make<{}>();
      let reads = 0;
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "local",
        httpBaseUrl: "https://local.example.test",
        wsBaseUrl: "wss://local.example.test",
      });
      const client = {
        [WS_METHODS.issueWorkRoadmap]: () =>
          Effect.sync(() => {
            listReads++;
            return {} as RepositoryIssueListResult;
          }),
        [WS_METHODS.issuesStatusBatch]: (input: IssueStatusBatchInput) =>
          Effect.gen(function* () {
            batchReads++;
            batchRefreshModes.push(input.refresh!);
            if (batchReads === 2) yield* Deferred.succeed(batchRefreshed, undefined);
            return [];
          }),
        [WS_METHODS.issuesInboxSubscribeUnread]: () => SubscriptionRef.changes(inbox),
        [WS_METHODS.issuesRepositoryStatus]: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 2) yield* Deferred.succeed(refreshed, undefined);
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(response);
          }),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
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
      const queries = createRepositoryIssueEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
        () => Atom.make(null),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const repository = { host: "github.com", repository: "owner/repo" };
      const issue = { number: 13, repository: "Owner/Repo", host: "GitHub.com" };
      const atoms: Array<Atom.Atom<AsyncResult.AsyncResult<unknown, Error>>> = [
        repository,
        issue,
        { ...issue, number: 14 },
      ].map((input) => queries.repositoryStatus({ environmentId, input }));
      const listTarget = { environmentId, input: repository };
      const firstIssue = { host: "github.com", nodeId: "I_1" };
      const secondIssue = { host: "github.com", nodeId: "I_2" };
      atoms.push(
        queries.list(listTarget),
        queries.list(listTarget),
        queries.statusBatch({ environmentId, input: { issues: [firstIssue, secondIssue] } }),
        queries.statusBatch({
          environmentId,
          input: { issues: [secondIssue, firstIssue, firstIssue] },
        }),
      );
      for (const atom of atoms) {
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
      }
      yield* Deferred.await(started);
      yield* Deferred.succeed(response, {});
      for (const atom of atoms)
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      expect(reads).toBe(1);
      expect(listReads).toBe(1);
      expect(batchReads).toBe(1);
      yield* SubscriptionRef.set(inbox, 1);
      yield* Deferred.await(refreshed);
      yield* Deferred.await(batchRefreshed);
      for (const atom of atoms)
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      expect(reads).toBe(2);
      expect(batchRefreshModes).toEqual([false, false]);
      const statuses = queries.statusBatch({
        environmentId,
        input: { issues: [secondIssue, firstIssue] },
      });
      registry.refresh(statuses);
      yield* AtomRegistry.getResult(registry, statuses, { suspendOnWaiting: true });
      expect(batchRefreshModes).toEqual([false, false, true]);
    }),
  ),
);
