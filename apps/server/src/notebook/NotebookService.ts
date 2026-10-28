// @effect-diagnostics nodeBuiltinImport:off
// Canonical filesystem identities and disk hashes use Node primitives.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  NotebookError,
  NOTEBOOK_LIMITS,
  type NotebookSnapshot,
  type NotebookOutputPatch,
  type NotebookEvent,
  type NotebookIdentity,
  type NotebookHandle,
  type NotebookExecute,
  type NotebookControl,
  type NotebookInterrupt,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as JupyterTransport from "./JupyterTransport.ts";
import { byteLength, parseNotebook } from "./notebookDocument.ts";
import { ExecutionReducer } from "./executionReducer.ts";

// Trusted composition supplies configured endpoints and secrets; RPC callers cannot choose one.
export class NotebookConfiguration extends Context.Service<
  NotebookConfiguration,
  {
    readonly endpoint: (root: string) => Effect.Effect<JupyterTransport.Endpoint, NotebookError>;
  }
>()("t3/notebook/NotebookService/NotebookConfiguration") {}
const disabled = Layer.succeed(NotebookConfiguration, {
  endpoint: Effect.fn("NotebookConfiguration.endpoint")(() =>
    Effect.fail(new NotebookError({ reason: "unavailable" })),
  ),
});
const fingerprintOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Caller = { readonly scopes: readonly AuthEnvironmentScope[] };
export class NotebookService extends Context.Service<
  NotebookService,
  {
    readonly open: (
      input: NotebookIdentity,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly snapshot: (
      input: NotebookHandle,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly execute: (
      input: NotebookExecute,
      caller: Caller,
    ) => Effect.Effect<string, NotebookError>;
    readonly interrupt: (
      input: NotebookInterrupt,
      caller: Caller,
    ) => Effect.Effect<void, NotebookError>;
    readonly restart: (
      input: NotebookControl,
      caller: Caller,
    ) => Effect.Effect<void, NotebookError>;
    readonly shutdown: (
      input: NotebookControl,
      caller: Caller,
    ) => Effect.Effect<void, NotebookError>;
    readonly subscribe: (
      input: NotebookHandle,
      caller: Caller,
    ) => Stream.Stream<NotebookEvent, NotebookError>;
  }
>()("t3/notebook/NotebookService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* NotebookConfiguration;
  const transport = yield* JupyterTransport.JupyterTransport;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const epoch = NodeCrypto.randomUUID();
  type Session = {
    projectId: string;
    path: string;
    root: string;
    snapshot: { -readonly [K in keyof NotebookSnapshot]: NotebookSnapshot[K] };
    reducer: ExecutionReducer;
    kernel?: {
      id: string;
      endpoint: JupyterTransport.Endpoint;
      channels: JupyterTransport.Channels;
      scope: Scope.Closeable;
    };
    pending?: { id: string; done: Deferred.Deferred<boolean> };
    cancelled: boolean;
    requests: Map<string, { fingerprint: string; runId: string }>;
    observers: Set<Queue.Queue<NotebookEvent>>;
  };
  const sessions = new Map<string, Session>();
  const authorize = Effect.fn("NotebookService.authorize")(function* (
    caller: Caller,
    execute = false,
  ) {
    if (
      !caller.scopes.includes("filesystem:read") ||
      (execute && !caller.scopes.includes("terminal:operate"))
    )
      return yield* new NotebookError({ reason: "permission-denied" });
  });
  const resolve = Effect.fn("NotebookService.resolve")(function* (input: NotebookIdentity) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError(() => new NotebookError({ reason: "not-found" })));
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new NotebookError({ reason: "not-found" });
    const root = yield* fs
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.mapError(() => new NotebookError({ reason: "invalid-path" })));
    if (NodePath.isAbsolute(input.relativePath) || !input.relativePath.endsWith(".ipynb"))
      return yield* new NotebookError({ reason: "invalid-path" });
    const path = yield* fs
      .realPath(NodePath.resolve(root, input.relativePath))
      .pipe(Effect.mapError(() => new NotebookError({ reason: "invalid-path" })));
    const relative = NodePath.relative(root, path);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      return yield* new NotebookError({ reason: "invalid-path" });
    return { root, path };
  });
  const get = Effect.fn("NotebookService.get")(function* (
    input: NotebookHandle,
    caller: Caller,
    execute = false,
  ) {
    yield* authorize(caller, execute);
    const session = sessions.get(input.handle);
    if (!session || session.projectId !== input.projectId)
      return yield* new NotebookError({ reason: "not-found" });
    const resolved = yield* resolve({
      projectId: input.projectId,
      relativePath: NodePath.relative(session.root, session.path),
    });
    if (resolved.path !== session.path || resolved.root !== session.root)
      return yield* new NotebookError({ reason: "invalid-path" });
    return session;
  });
  const snapshotOf = (session: Session) => structuredClone(session.snapshot);
  const changed = (
    session: Session,
    cellId: string | null = null,
    patches: readonly NotebookOutputPatch[] = [],
  ) => {
    const s = session.snapshot;
    s.sequence++;
    s.revision++;
    s.truncated = session.reducer.truncated;
    const delta: NotebookEvent = {
      type: "changed",
      patches,
      kernel: s.kernel,
      outcome: s.outcome,
      truncated: s.truncated,
      epoch,
      sequence: s.sequence,
      revision: s.revision,
      generation: s.generation,
      runId: cellId === null ? s.runId : (s.executions[cellId]?.runId ?? s.runId),
      cellId,
    };
    const event: NotebookEvent =
      byteLength(delta) > NOTEBOOK_LIMITS.frameBytes
        ? { type: "resync-required", epoch, sequence: s.sequence }
        : delta;
    for (const queue of session.observers) {
      if (!Queue.offerUnsafe(queue, event)) {
        for (let i = 0; i < 32; i++) Queue.takeUnsafe(queue);
        Queue.offerUnsafe(queue, { type: "resync-required", epoch, sequence: s.sequence });
      }
    }
  };
  const unknown = Effect.fn("NotebookService.disconnected")(function* (session: Session) {
    session.cancelled = true;
    session.snapshot.kernel = "unknown";
    session.snapshot.outcome = "unknown";
    if (session.pending) yield* Deferred.succeed(session.pending.done, true);
    changed(session);
  });
  const connectOwned = Effect.fn("NotebookService.connectOwned")(function* (
    session: Session,
    endpoint: JupyterTransport.Endpoint,
    id: string,
  ) {
    const kernelScope = yield* Scope.make();
    const channels = yield* transport.connect(endpoint, id).pipe(
      Effect.provideService(Scope.Scope, kernelScope),
      Effect.onError(() =>
        Effect.all(
          [
            Scope.close(kernelScope, Exit.void),
            transport.control(endpoint, id, "shutdown").pipe(Effect.ignore),
            unknown(session),
          ],
          { discard: true },
        ),
      ),
    );
    session.kernel = { id, endpoint, channels, scope: kernelScope };
    const generation = session.snapshot.generation;
    yield* Stream.runForEach(channels.messages, (message) =>
      Effect.gen(function* () {
        if (session.snapshot.generation !== generation) return;
        const result = session.reducer.reduce(message);
        if (!result) return;
        changed(session, result.cellId, result.patches);
        const pending = session.pending;
        if (result.complete && pending && pending.id === message.parent_header.msg_id)
          yield* Deferred.succeed(pending.done, result.failed);
      }),
    ).pipe(
      Effect.catch(() =>
        session.snapshot.generation === generation ? unknown(session) : Effect.void,
      ),
      Effect.forkIn(kernelScope),
    );
  });
  const open = Effect.fn("NotebookService.open")(function* (
    input: NotebookIdentity,
    caller: Caller,
  ) {
    yield* authorize(caller);
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const { root, path } = yield* resolve(input);
        for (const session of sessions.values())
          if (
            session.path === path &&
            session.root === root &&
            session.projectId === input.projectId
          )
            return snapshotOf(session);
        if (sessions.size >= NOTEBOOK_LIMITS.sessions)
          return yield* new NotebookError({ reason: "output-limit" });
        const stat = yield* fs
          .stat(path)
          .pipe(Effect.mapError(() => new NotebookError({ reason: "not-found" })));
        if (stat.size > NOTEBOOK_LIMITS.bytes)
          return yield* new NotebookError({ reason: "output-limit" });
        const text = yield* fs
          .readFileString(path)
          .pipe(Effect.mapError(() => new NotebookError({ reason: "not-found" })));
        const parsed = yield* Effect.try({
          try: () => parseNotebook(text),
          catch: () => new NotebookError({ reason: "invalid-document" }),
        });
        const handle = NodeCrypto.randomUUID();
        const snapshot: NotebookSnapshot = {
          handle,
          epoch,
          sequence: 0,
          revision: parsed.changed ? 1 : 0,
          diskHash: NodeCrypto.createHash("sha256").update(text).digest("hex"),
          generation: 0,
          executions: {},
          document: parsed.document,
          kernel: "stopped",
          runId: null,
          outcome: "none",
          truncated: false,
        };
        const session: Session = {
          projectId: input.projectId,
          path,
          root,
          snapshot,
          reducer: new ExecutionReducer(parsed.document),
          cancelled: false,
          requests: new Map(),
          observers: new Set(),
        };
        sessions.set(handle, session);
        return snapshotOf(session);
      }),
    );
  });
  const snapshot = Effect.fn("NotebookService.snapshot")(function* (
    input: NotebookHandle,
    caller: Caller,
  ) {
    return snapshotOf(yield* get(input, caller));
  });
  const execute = Effect.fn("NotebookService.execute")(function* (
    input: NotebookExecute,
    caller: Caller,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const session = yield* get(input, caller, true);
        const fingerprint = fingerprintOf([input.revision, input.cellIds]);
        const prior = session.requests.get(input.requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            return yield* new NotebookError({ reason: "stale-revision" });
          return prior.runId;
        }
        if (session.snapshot.outcome === "running")
          return yield* new NotebookError({ reason: "busy" });
        if (session.snapshot.kernel === "unknown")
          return yield* new NotebookError({ reason: "disconnected" });
        if (input.revision !== session.snapshot.revision)
          return yield* new NotebookError({ reason: "stale-revision" });
        const cells = input.cellIds.map((id) =>
          session.reducer.document.cells.find((c) => c.id === id),
        );
        if (
          !input.requestId ||
          input.requestId.length > 128 ||
          !cells.length ||
          cells.length > NOTEBOOK_LIMITS.cells ||
          new Set(input.cellIds).size !== cells.length ||
          cells.some((c) => !c || c.cell_type !== "code")
        )
          return yield* new NotebookError({ reason: "invalid-document" });
        if (session.requests.size >= 128)
          return yield* new NotebookError({ reason: "output-limit" });
        if (!session.kernel) {
          const endpoint = yield* config.endpoint(session.root);
          const id = yield* transport.create(endpoint, session.root);
          session.snapshot.generation++;
          yield* connectOwned(session, endpoint, id);
        }
        const kernel = session.kernel;
        if (!kernel) return yield* new NotebookError({ reason: "kernel-failure" });
        const runId = NodeCrypto.randomUUID();
        session.snapshot.runId = runId;
        session.snapshot.outcome = "running";
        session.snapshot.kernel = "busy";
        session.cancelled = false;
        session.requests.set(input.requestId, { fingerprint, runId });
        changed(session);
        const generation = session.snapshot.generation;
        const sourceRevision = input.revision;
        yield* Effect.gen(function* () {
          let failed = false;
          for (const cell of cells) {
            if (!cell || session.cancelled || session.snapshot.generation !== generation) break;
            const id = NodeCrypto.randomUUID();
            const done = yield* Deferred.make<boolean>();
            session.pending = { id, done };
            session.snapshot.executions = {
              ...session.snapshot.executions,
              [cell.id]: {
                runId,
                generation,
                sourceRevision,
                sourceHash: NodeCrypto.createHash("sha256")
                  .update(typeof cell.source === "string" ? cell.source : cell.source.join(""))
                  .digest("hex"),
              },
            };
            session.reducer.begin(id, cell);
            changed(session, cell.id, [{ type: "clear", cellId: cell.id }]);
            yield* kernel.channels.execute(
              id,
              typeof cell.source === "string" ? cell.source : cell.source.join(""),
            );
            failed = yield* Deferred.await(done);
            if (session.pending?.id === id) delete session.pending;
            if (failed) break;
          }
          if (
            session.snapshot.generation === generation &&
            session.snapshot.outcome === "running"
          ) {
            session.snapshot.outcome = session.cancelled ? "aborted" : failed ? "error" : "ok";
            session.snapshot.kernel = "idle";
            changed(session);
          }
        }).pipe(
          Effect.catch(() =>
            session.snapshot.generation === generation ? unknown(session) : Effect.void,
          ),
          Effect.forkIn(scope),
        );
        return runId;
      }),
    );
  });
  const control = (action: "interrupt" | "restart" | "shutdown") =>
    Effect.fn(`NotebookService.${action}`)(function* (
      input: NotebookControl & { runId?: string },
      caller: Caller,
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const session = yield* get(input, caller, true);
          if (session.snapshot.generation !== input.generation)
            return yield* new NotebookError({ reason: "stale-generation" });
          if (action === "interrupt" && input.runId !== session.snapshot.runId)
            return yield* new NotebookError({ reason: "stale-revision" });
          const kernel = session.kernel;
          if (!kernel) {
            if (action !== "interrupt") {
              session.snapshot.kernel = "stopped";
              session.snapshot.outcome = "aborted";
              changed(session);
            }
            return;
          }
          session.cancelled = true;
          yield* transport
            .control(kernel.endpoint, kernel.id, action)
            .pipe(Effect.onError(() => unknown(session)));
          if (action !== "interrupt") {
            session.snapshot.generation++;
            session.reducer.owners.clear();
            if (session.pending) yield* Deferred.succeed(session.pending.done, true);
            yield* Scope.close(kernel.scope, Exit.void);
            delete session.kernel;
            if (action === "restart") yield* connectOwned(session, kernel.endpoint, kernel.id);
            session.snapshot.kernel = action === "restart" ? "idle" : "stopped";
            session.snapshot.outcome = "aborted";
          }
          changed(session);
        }),
      );
    });
  const subscribe = (input: NotebookHandle, caller: Caller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const session = yield* get(input, caller);
        const queue = yield* Queue.dropping<NotebookEvent>(32);
        session.observers.add(queue);
        const initial = snapshotOf(session);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            session.observers.delete(queue);
            Queue.shutdownUnsafe(queue);
          }),
        );
        return Stream.concat(
          Stream.make({ type: "snapshot", snapshot: initial } as NotebookEvent),
          Stream.fromQueue(queue),
        );
      }),
    );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions.values(),
      (session) =>
        Effect.gen(function* () {
          const kernel = session.kernel;
          if (!kernel) return;
          session.snapshot.generation++;
          yield* Scope.close(kernel.scope, Exit.void);
          yield* transport.control(kernel.endpoint, kernel.id, "shutdown").pipe(Effect.ignore);
        }),
      { discard: true },
    ),
  );

  return NotebookService.of({
    open,
    snapshot,
    execute,
    interrupt: control("interrupt"),
    restart: control("restart"),
    shutdown: control("shutdown"),
    subscribe,
  });
});
export const layer = Layer.effect(NotebookService, make);
export const layerDisabled = layer.pipe(
  Layer.provide(disabled),
  Layer.provide(JupyterTransport.layer),
);
