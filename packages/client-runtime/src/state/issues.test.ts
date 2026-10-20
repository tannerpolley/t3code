import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  WS_METHODS,
  type IssueDetailInput,
  type IssueListInput,
  type IssueListResult,
  type IssueDetailResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

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

it.effect("filters issue turns and throttles bursts with a trailing refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("local");
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const thread = (id: string, run: string, linked = false): OrchestrationV2ThreadShell =>
        ({
          id: ThreadId.make(id),
          latestRunId: RunId.make(run),
          latestRunCompletedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
          ...(linked
            ? {
                linkedIssue: {
                  host: "GITHUB.COM",
                  repository: "OWNER/REPO",
                  number: id === "unrelated" ? 2 : 1,
                },
              }
            : {}),
        }) as unknown as OrchestrationV2ThreadShell;
      const snapshot = (threads: OrchestrationV2ThreadShell[]) =>
        ({
          schemaVersion: 1,
          snapshotSequence: 0,
          projects: [],
          archivedThreads: [],
          threads,
        }) satisfies OrchestrationV2ShellSnapshot;
      const shells = Atom.make<OrchestrationV2ShellSnapshot | null>(
        snapshot([
          thread("linked", "initial", true),
          thread("worker", "initial"),
          thread("unrelated", "initial", true),
        ]),
      );
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
                liveWork: [
                  {
                    threadId: ThreadId.make("worker"),
                    status: "idle",
                    title: "Worker",
                    branch: null,
                    worktreePath: null,
                    pullRequests: [],
                  },
                ],
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
        () => shells,
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

      const update = (linkedRun: string, workerRun: string, unrelatedRun: string) =>
        Effect.sync(() =>
          registry.set(
            shells,
            snapshot([
              thread("linked", linkedRun, true),
              thread("worker", workerRun),
              thread("unrelated", unrelatedRun, true),
            ]),
          ),
        ).pipe(Effect.andThen(Effect.promise(() => vi.advanceTimersByTimeAsync(0))));
      yield* update("initial", "initial", "unrelated-finished");
      expect(reads).toEqual([1]);
      yield* Effect.sync(() =>
        registry.set(
          shells,
          snapshot([
            { ...thread("linked", "linked-finished", true), latestRunCompletedAt: null },
            thread("worker", "initial"),
            thread("unrelated", "unrelated-finished", true),
          ]),
        ),
      );
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      expect(reads).toEqual([1]);
      yield* update("linked-finished", "initial", "unrelated-finished");
      yield* Deferred.await(secondRead);
      expect(reads).toEqual([1, 1]);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000));
      yield* update("linked-finished", "worker-finished", "unrelated-finished");
      yield* update("linked-again", "worker-finished", "unrelated-finished");
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(49_999));
      expect(reads).toEqual([1, 1]);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
      expect(reads).toEqual([1, 1, 1]);
      // A worker without its own linkedIssue also refreshes through the detail's liveWork.
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      yield* update("linked-again", "worker-again", "unrelated-finished");
      expect(reads).toEqual([1, 1, 1, 1]);
      yield* update("linked-final", "worker-again", "unrelated-finished");
      yield* Effect.sync(() => registry.refresh(detail));
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      expect(reads).toEqual([1, 1, 1, 1, 1]);
      unmount();
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      expect(reads).toHaveLength(5);
    }),
  ),
);

it.effect("issue lists ignore turn-finished refreshes and still refresh on link changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("local");
      const reads: string[] = [];
      const linkChanges = yield* SubscriptionRef.make(0);
      const turnFinished = yield* SubscriptionRef.make(0);
      const linkDetailRead = yield* Deferred.make<void>();
      let detailReads = 0;
      const secondRead = yield* Deferred.make<void>();
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "local",
        httpBaseUrl: "https://local.example.test",
        wsBaseUrl: "wss://local.example.test",
      });
      const client = {
        [WS_METHODS.issuesSubscribeLinkRefreshes]: () => SubscriptionRef.changes(linkChanges),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => SubscriptionRef.changes(turnFinished),
        [WS_METHODS.issuesDetail]: () =>
          Effect.gen(function* () {
            if (++detailReads === 2) yield* Deferred.succeed(linkDetailRead, undefined);
            return {} as IssueDetailResult;
          }),
        [WS_METHODS.issuesList]: (input: IssueListInput) =>
          Effect.gen(function* () {
            reads.push(input.roadmap ? "roadmap" : input.repository);
            if (reads.length === 6) yield* Deferred.succeed(secondRead, undefined);
            return {
              repository: { host: input.host, repository: input.repository },
              viewer: null,
              fetchedAt: "2026-10-13T00:00:00Z",
              issues: [],
              milestones: [],
              nextCursor: null,
              issuesComplete: true,
              milestonesComplete: true,
            } satisfies IssueListResult;
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
        () => Atom.make(null),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const input = { host: "github.com", repository: "owner/repo" };
      const lists = [
        queries.roadmapList({ environmentId, input: { ...input, roadmap: true } }),
        queries.list({ environmentId, input }),
        queries.liveList({ environmentId, input: { ...input, repository: "owner/live" } }),
      ];
      const detail = queries.detail({ environmentId, input: { ...input, number: 1 } });
      for (const atom of lists) {
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      }
      const unmountDetail = registry.mount(detail);
      yield* Effect.addFinalizer(() => Effect.sync(unmountDetail));
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      expect(reads).toHaveLength(3);
      expect(detailReads).toBe(1);
      yield* SubscriptionRef.set(turnFinished, 1);
      yield* Effect.yieldNow;
      expect(detailReads).toBe(1);
      for (const atom of lists)
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      expect(reads).toHaveLength(3);

      yield* SubscriptionRef.set(linkChanges, 1);
      yield* Deferred.await(secondRead);
      for (const atom of lists)
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* Deferred.await(linkDetailRead);
      expect(detailReads).toBe(2);
      expect(reads).toEqual([
        "roadmap",
        "owner/repo",
        "owner/live",
        "roadmap",
        "owner/repo",
        "owner/live",
      ]);
    }),
  ),
);
