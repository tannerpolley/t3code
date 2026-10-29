import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
// @effect-diagnostics nodeBuiltinImport:off
// Canonical filesystem identities and disk hashes use Node primitives.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  NotebookError,
  type NotebookEditCells,
  type NotebookKernelList,
  NOTEBOOK_LIMITS,
  type NotebookSubscribe,
  type NotebookSave,
  type NotebookEdit,
  type NotebookCreate,
  type NotebookLease,
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
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
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
    readonly endpoint: (
      root: string,
    ) => Effect.Effect<JupyterTransport.Endpoint & { readonly profileHash: string }, NotebookError>;
    readonly owned: (
      root: string,
      profileHash: string,
      id: string,
    ) => Effect.Effect<void, NotebookError>;
    readonly released: (root: string, id: string) => Effect.Effect<void, NotebookError>;
  }
>()("t3/notebook/NotebookService/NotebookConfiguration") {}
const fingerprintOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Caller = { readonly scopes: readonly AuthEnvironmentScope[] };
export class NotebookService extends Context.Service<
  NotebookService,
  {
    readonly editCells: (
      input: NotebookEditCells,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly listKernels: (
      input: Pick<NotebookIdentity, "projectId" | "threadId"> & { cursor: number; limit: number },
      caller: Caller,
    ) => Effect.Effect<NotebookKernelList, NotebookError>;
    readonly readOutputs: (
      input: NotebookHandle & {
        readonly cellId: string;
        readonly cursor: number;
        readonly byteLimit: number;
        readonly offset?: number | undefined;
        readonly afterSequence?: number | undefined;
      },
      caller: Caller,
    ) => Effect.Effect<
      {
        readonly outputs: readonly Record<string, unknown>[];
        readonly nextCursor: number | null;
        readonly nextOffset: number;
        readonly fragment: { readonly offset: number; readonly json: string } | null;
        readonly truncated: boolean;
        readonly epoch: string;
        readonly sequence: number;
        readonly revision: number;
        readonly generation: number;
        readonly runId: string | null;
        readonly outcome: NotebookSnapshot["outcome"];
        readonly kernel: NotebookSnapshot["kernel"];
        readonly execution: NotebookSnapshot["executions"][string] | null;
      },
      NotebookError
    >;
    readonly reload: (
      input: NotebookSave,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly save: (
      input: NotebookSave,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly edit: (
      input: NotebookEdit,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly create: (
      input: NotebookCreate,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly acquire: (
      input: NotebookLease,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly close: (input: NotebookLease, caller: Caller) => Effect.Effect<void, NotebookError>;
    readonly open: (
      input: NotebookIdentity,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly snapshot: (
      input: NotebookHandle,
      caller: Caller,
    ) => Effect.Effect<NotebookSnapshot, NotebookError>;
    readonly run: (
      input: NotebookHandle & {
        revision: number;
        requestId: string;
        cellIds?: readonly string[] | undefined;
        all?: boolean | undefined;
      },
      caller: Caller,
    ) => Effect.Effect<string, NotebookError>;
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
      input: NotebookSubscribe,
      caller: Caller,
    ) => Stream.Stream<NotebookEvent, NotebookError>;
  }
>()("t3/notebook/NotebookService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const config = yield* NotebookConfiguration;
  const transport = yield* JupyterTransport.JupyterTransport;
  const scope = yield* Scope.Scope;
  const epoch = NodeCrypto.randomUUID();
  type Session = {
    projects: Set<string>;
    lock: Semaphore.Semaphore;
    path: string;
    root: string;
    snapshot: { -readonly [K in keyof NotebookSnapshot]: NotebookSnapshot[K] };
    reducer: ExecutionReducer;
    kernel?: {
      id: string;
      endpoint: JupyterTransport.Endpoint;
      channels?: JupyterTransport.Channels;
      scope?: Scope.Closeable;
    };
    pending?: { id: string; done: Deferred.Deferred<boolean> };
    cancelled: boolean;
    requests: Map<string, { fingerprint: string; runId: string }>;
    observers: Set<Queue.Queue<NotebookEvent>>;
    leases: Map<string, symbol>;
    timer?: Fiber.Fiber<void, never>;
    lastExecution: number;
    updated: Deferred.Deferred<void>;
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
  const rootFor = Effect.fn("NotebookService.rootFor")(function* (
    input: Pick<NotebookIdentity, "projectId" | "threadId">,
  ) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError(() => new NotebookError({ reason: "not-found" })));
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new NotebookError({ reason: "not-found" });
    const root = yield* fs
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.mapError(() => new NotebookError({ reason: "invalid-path" })));
    if (!input.threadId) return root;
    const rows = yield* sql<{ readonly worktreePath: string | null }>`
      SELECT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId} AND deleted_at IS NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(() => new NotebookError({ reason: "not-found" })),
    );
    if (!rows[0]) return yield* new NotebookError({ reason: "not-found" });
    if (rows[0].worktreePath === null) return root;
    const requested = rows[0].worktreePath;
    if (!NodePath.isAbsolute(requested))
      return yield* new NotebookError({ reason: "invalid-path" });
    const candidate = yield* fs
      .realPath(requested)
      .pipe(Effect.mapError(() => new NotebookError({ reason: "invalid-path" })));
    const worktrees = yield* git
      .listWorktreePaths(root)
      .pipe(Effect.mapError(() => new NotebookError({ reason: "invalid-path" })));
    const canonical = yield* Effect.forEach(worktrees, (path) =>
      fs.realPath(path).pipe(Effect.orElseSucceed(() => null)),
    );
    if (!canonical.includes(candidate)) return yield* new NotebookError({ reason: "invalid-path" });
    return candidate;
  });
  const resolve = Effect.fn("NotebookService.resolve")(function* (input: NotebookIdentity) {
    const root = yield* rootFor(input);
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
    if (!session || !session.projects.has(input.projectId))
      return yield* new NotebookError({ reason: "not-found" });
    const resolved = yield* resolve({
      projectId: input.projectId,
      threadId: input.threadId,
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
    resync = false,
    advance = true,
  ) => {
    Deferred.doneUnsafe(session.updated, Effect.void);
    session.updated = Deferred.makeUnsafe<void>();
    const s = session.snapshot;
    s.sequence++;
    if (advance) s.revision++;
    s.truncated = session.reducer.truncated;
    const delta: NotebookEvent = {
      type: "changed",
      patches,
      kernel: s.kernel,
      outcome: s.outcome,
      truncated: s.truncated,
      savedRevision: s.savedRevision,
      diskHash: s.diskHash,
      idleDeadline: s.idleDeadline,
      availability: s.availability,
      environment: s.environment,
      epoch,
      sequence: s.sequence,
      revision: s.revision,
      generation: s.generation,
      runId: s.runId,
      cellId,
    };
    const event: NotebookEvent =
      resync || byteLength(delta) > NOTEBOOK_LIMITS.frameBytes
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
    session.snapshot.idleDeadline = null;
    if (session.pending) yield* Deferred.succeed(session.pending.done, true);
    changed(session);
  });
  const connectOwned = Effect.fn("NotebookService.connectOwned")(function* (
    session: Session,
    endpoint: JupyterTransport.Endpoint,
    id: string,
  ) {
    const kernelScope = yield* Scope.make();
    session.kernel = { id, endpoint, scope: kernelScope };
    const channels = yield* transport.connect(endpoint, id).pipe(
      Effect.provideService(Scope.Scope, kernelScope),
      Effect.onError(() =>
        Effect.all(
          [
            Scope.close(kernelScope, Exit.void),
            transport.control(endpoint, id, "shutdown").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  delete session.kernel;
                }),
              ),
              Effect.ignore,
            ),
            unknown(session),
          ],
          { discard: true },
        ),
      ),
    );
    session.kernel = { id, endpoint, channels, scope: kernelScope };
    const generation = session.snapshot.generation;
    yield* Stream.runForEach(channels.messages, (message) =>
      session.lock.withPermit(
        Effect.gen(function* () {
          if (session.snapshot.generation !== generation) return;
          const result = session.reducer.reduce(message);
          if (!result) return;
          const patches = [...result.patches];
          if (
            message.header.msg_type === "execute_reply" &&
            result.cellId !== null &&
            result.replyStatus !== undefined
          ) {
            const execution = session.snapshot.executions[result.cellId];
            if (execution) {
              const updated = { ...execution, replyStatus: result.replyStatus };
              session.snapshot.executions = {
                ...session.snapshot.executions,
                [result.cellId]: updated,
              };
              const cell = session.reducer.document.cells.find((cell) => cell.id === result.cellId);
              patches.push({
                type: "execution",
                cellId: result.cellId,
                count: cell?.execution_count ?? null,
                execution: updated,
              });
            }
          }
          changed(session, result.cellId, patches);
          const pending = session.pending;
          if (result.complete && pending && pending.id === message.parent_header.msg_id) {
            if (result.replyStatus === "aborted") session.cancelled = true;
            yield* Deferred.succeed(pending.done, result.failed);
          }
        }),
      ),
    ).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          session.snapshot.generation === generation ? unknown(session) : Effect.void,
        ),
      ),
      Effect.catch(() =>
        session.snapshot.generation === generation ? unknown(session) : Effect.void,
      ),
      Effect.forkIn(kernelScope),
    );
  });
  const arm = Effect.fn("NotebookService.arm")(function* (session: Session, grace = true) {
    if (session.timer) yield* Fiber.interrupt(session.timer);
    if (
      !session.kernel ||
      session.snapshot.outcome === "running" ||
      session.snapshot.outcome === "unknown"
    ) {
      session.snapshot.idleDeadline = null;
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    const deadline = session.leases.size
      ? session.lastExecution + 15 * 60_000
      : now + (grace ? 60_000 : 0);
    session.snapshot.idleDeadline = deadline;
    session.timer = yield* Effect.sleep(Math.max(0, deadline - now)).pipe(
      Effect.andThen(
        session.lock.withPermit(
          Effect.gen(function* () {
            if (session.snapshot.outcome === "running" || session.snapshot.outcome === "unknown")
              return;
            const kernel = session.kernel;
            if (!kernel) return;
            yield* transport.control(kernel.endpoint, kernel.id, "shutdown");
            session.snapshot.generation++;
            session.reducer.resetGeneration();
            if (kernel.scope) yield* Scope.close(kernel.scope, Exit.void);
            yield* config.released(session.root, kernel.id);
            delete session.kernel;
            session.snapshot.kernel = "stopped";
            session.snapshot.environment = "unverified";
            session.snapshot.idleDeadline = null;
            changed(session);
          }),
        ),
      ),
      Effect.catch(() => unknown(session)),
      Effect.forkIn(scope),
    );
  });
  const open = Effect.fn("NotebookService.open")(function* (
    input: NotebookIdentity,
    caller: Caller,
  ) {
    yield* authorize(caller);
    const { root, path } = yield* resolve(input);
    for (const session of sessions.values())
      if (session.path === path && session.root === root) {
        session.projects.add(input.projectId);
        session.snapshot.availability = yield* config.endpoint(root).pipe(
          Effect.tap(transport.probe),
          Effect.as("available" as const),
          Effect.orElseSucceed(() => "unavailable" as const),
        );
        return snapshotOf(session);
      }
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
    const availability = yield* config.endpoint(root).pipe(
      Effect.tap(transport.probe),
      Effect.as("available" as const),
      Effect.orElseSucceed(() => "unavailable" as const),
    );
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.try({
      try: () => {
        for (const session of sessions.values()) {
          if (session.path === path && session.root === root) {
            session.projects.add(input.projectId);
            session.snapshot.availability = availability;
            return snapshotOf(session);
          }
        }
        if (sessions.size >= NOTEBOOK_LIMITS.sessions)
          throw new NotebookError({ reason: "output-limit" });
        const handle = NodeCrypto.randomUUID();
        const snapshot: NotebookSnapshot = {
          handle,
          epoch,
          sequence: 0,
          revision: parsed.changed ? 1 : 0,
          savedRevision: 0,
          idleDeadline: null,
          availability,
          environment: "unverified",
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
          projects: new Set([input.projectId]),
          lock: Semaphore.makeUnsafe(1),
          path,
          root,
          snapshot,
          reducer: new ExecutionReducer(parsed.document),
          cancelled: false,
          requests: new Map(),
          updated: Deferred.makeUnsafe<void>(),
          observers: new Set(),
          leases: new Map(),
          lastExecution: now,
        };
        sessions.set(handle, session);
        return snapshotOf(session);
      },
      catch: () => new NotebookError({ reason: "output-limit" }),
    });
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
    const session = yield* get(input, caller, true);
    return yield* session.lock.withPermit(
      Effect.gen(function* () {
        yield* get(input, caller, true);
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
          yield* transport.probe(endpoint);
          session.snapshot.availability = "available";
          const id = yield* transport.create(endpoint, session.root);
          session.kernel = { id, endpoint };
          yield* config
            .owned(session.root, endpoint.profileHash, id)
            .pipe(
              Effect.onError(() => transport.control(endpoint, id, "shutdown").pipe(Effect.ignore)),
            );
          session.snapshot.generation++;
          session.reducer.resetGeneration();
          yield* transport
            .verify(endpoint, id, session.root)
            .pipe(Effect.onError(() => unknown(session).pipe(Effect.andThen(arm(session)))));
          session.snapshot.environment = "verified";
          yield* connectOwned(session, endpoint, id);
        }
        const kernel = session.kernel;
        const configured = yield* config.endpoint(session.root);
        if (kernel && fingerprintOf(configured) !== fingerprintOf(kernel.endpoint))
          return yield* new NotebookError({ reason: "unavailable" });
        if (!kernel?.channels) return yield* new NotebookError({ reason: "kernel-failure" });
        const channels = kernel.channels;
        session.lastExecution = yield* Clock.currentTimeMillis;
        const runId = NodeCrypto.randomUUID();
        session.snapshot.runId = runId;
        session.snapshot.outcome = "running";
        session.snapshot.kernel = "busy";
        session.cancelled = false;
        session.requests.set(input.requestId, { fingerprint, runId });
        yield* arm(session);
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
            yield* Effect.try({
              try: () => session.reducer.begin(id, cell),
              catch: () => new NotebookError({ reason: "output-limit" }),
            });
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
            changed(session, cell.id, [
              { type: "clear", cellId: cell.id },
              {
                type: "execution",
                cellId: cell.id,
                count: null,
                execution: session.snapshot.executions[cell.id]!,
              },
            ]);
            yield* channels.execute(
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
            yield* arm(session);
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
  const run = Effect.fn("NotebookService.run")(function* (
    input: NotebookHandle & {
      revision: number;
      requestId: string;
      cellIds?: readonly string[] | undefined;
      all?: boolean | undefined;
    },
    caller: Caller,
  ) {
    const session = yield* get(input, caller, true);
    if ((input.all === true) === (input.cellIds !== undefined))
      return yield* new NotebookError({ reason: "invalid-document" });
    const cellIds =
      input.all === true
        ? session.reducer.document.cells
            .filter((cell) => cell.cell_type === "code")
            .map((cell) => cell.id)
        : input.cellIds!;
    return yield* execute({ ...input, cellIds }, caller);
  });
  const control = (action: "interrupt" | "restart" | "shutdown") =>
    Effect.fn(`NotebookService.${action}`)(function* (
      input: NotebookControl & { runId?: string },
      caller: Caller,
    ) {
      const session = yield* get(input, caller, true);
      yield* session.lock.withPermit(
        Effect.gen(function* () {
          yield* get(input, caller, true);
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
            session.reducer.resetGeneration();
            if (session.pending) yield* Deferred.succeed(session.pending.done, true);
            if (kernel.scope) yield* Scope.close(kernel.scope, Exit.void);
            if (action === "restart") {
              session.kernel = { id: kernel.id, endpoint: kernel.endpoint };
              yield* transport
                .verify(kernel.endpoint, kernel.id, session.root)
                .pipe(Effect.onError(() => unknown(session).pipe(Effect.andThen(arm(session)))));
              yield* connectOwned(session, kernel.endpoint, kernel.id);
            } else {
              yield* config.released(session.root, kernel.id);
              delete session.kernel;
              session.snapshot.environment = "unverified";
            }
            session.snapshot.kernel = action === "restart" ? "idle" : "stopped";
            session.snapshot.outcome = "aborted";
            yield* arm(session);
          }
          changed(session);
        }),
      );
    });
  const readOutputs = Effect.fn("NotebookService.readOutputs")(function* (
    input: NotebookHandle & {
      readonly cellId: string;
      readonly cursor: number;
      readonly byteLimit: number;
      readonly offset?: number | undefined;
      readonly afterSequence?: number | undefined;
    },
    caller: Caller,
  ) {
    const session = yield* get(input, caller);
    if (input.afterSequence !== undefined && input.afterSequence >= session.snapshot.sequence) {
      yield* Deferred.await(session.updated).pipe(Effect.timeoutOption("25 seconds"));
      yield* get(input, caller);
    }
    const cell = session.reducer.document.cells.find((cell) => cell.id === input.cellId);
    if (!cell) return yield* new NotebookError({ reason: "not-found" });
    if (
      !Number.isInteger(input.cursor) ||
      input.cursor < 0 ||
      !Number.isInteger(input.byteLimit) ||
      input.byteLimit < 1 ||
      input.byteLimit > NOTEBOOK_LIMITS.frameBytes
    )
      return yield* new NotebookError({ reason: "output-limit" });
    const outputs = cell.outputs ?? [];
    const offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && input.cursor >= outputs.length))
      return yield* new NotebookError({ reason: "invalid-document" });
    const reply = {
      outputs: [] as Record<string, unknown>[],
      fragment: null as { offset: number; json: string } | null,
      nextCursor: input.cursor < outputs.length ? input.cursor : null,
      nextOffset: 0,
      truncated: session.snapshot.truncated,
      epoch,
      sequence: session.snapshot.sequence,
      revision: session.snapshot.revision,
      generation: session.snapshot.generation,
      runId: session.snapshot.runId,
      outcome: session.snapshot.outcome,
      kernel: session.snapshot.kernel,
      execution: session.snapshot.executions[input.cellId] ?? null,
    };
    let cursor = input.cursor;
    if (offset === 0) {
      while (cursor < outputs.length) {
        reply.outputs.push(outputs[cursor]!);
        reply.nextCursor = cursor + 1 < outputs.length ? cursor + 1 : null;
        if (byteLength(reply) > input.byteLimit) {
          reply.outputs.pop();
          reply.nextCursor = cursor;
          break;
        }
        cursor++;
      }
    }
    if (!reply.outputs.length && cursor < outputs.length) {
      const json = fingerprintOf(outputs[cursor]);
      if (offset >= json.length) return yield* new NotebookError({ reason: "invalid-document" });
      const fragmentAt = (end: number) => ({
        ...reply,
        fragment: { offset, json: json.slice(offset, end) },
        nextCursor: end < json.length ? cursor : cursor + 1 < outputs.length ? cursor + 1 : null,
        nextOffset: end < json.length ? end : 0,
      });
      let low = offset;
      let high = Math.min(json.length, offset + input.byteLimit);
      while (low < high) {
        const end = Math.ceil((low + high) / 2);
        if (byteLength(fragmentAt(end)) <= input.byteLimit) low = end;
        else high = end - 1;
      }
      if (low === offset) return yield* new NotebookError({ reason: "output-limit" });
      return fragmentAt(low);
    }
    if (byteLength(reply) > input.byteLimit)
      return yield* new NotebookError({ reason: "output-limit" });
    return structuredClone(reply);
  });
  const writable = Effect.fn("NotebookService.writable")(function* (caller: Caller) {
    if (!caller.scopes.includes("filesystem:write"))
      return yield* new NotebookError({ reason: "permission-denied" });
  });
  const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
  const save = Effect.fn("NotebookService.save")(function* (input: NotebookSave, caller: Caller) {
    yield* writable(caller);
    const session = yield* get(input, caller);
    return yield* session.lock.withPermit(
      Effect.gen(function* () {
        yield* get(input, caller);
        if (session.snapshot.outcome === "running")
          return yield* new NotebookError({ reason: "busy" });
        if (input.revision !== session.snapshot.revision)
          return yield* new NotebookError({ reason: "stale-revision" });
        const disk = yield* fs
          .readFileString(session.path)
          .pipe(Effect.mapError(() => new NotebookError({ reason: "save-conflict" })));
        if (input.diskHash !== session.snapshot.diskHash || hash(disk) !== input.diskHash)
          return yield* new NotebookError({ reason: "save-conflict" });
        const text = fingerprintOf(session.reducer.document);
        if (Buffer.byteLength(text) > NOTEBOOK_LIMITS.bytes)
          return yield* new NotebookError({ reason: "output-limit" });
        const temporary = NodePath.join(
          NodePath.dirname(session.path),
          `.t3-notebook-${NodeCrypto.randomUUID()}.tmp`,
        );
        yield* Effect.gen(function* () {
          yield* fs.writeFileString(temporary, text, { flag: "wx", mode: 0o600 });
          yield* get(input, caller);
          const current = yield* fs.readFileString(session.path);
          if (hash(current) !== input.diskHash)
            return yield* new NotebookError({ reason: "save-conflict" });
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* fs.rename(temporary, session.path);
              session.snapshot.diskHash = hash(text);
              session.snapshot.savedRevision = session.snapshot.revision;
              changed(session, null, [], false, false);
            }),
          );
        }).pipe(
          Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
          Effect.mapError(() => new NotebookError({ reason: "save-conflict" })),
        );
        return snapshotOf(session);
      }),
    );
  });
  const reload = Effect.fn("NotebookService.reload")(function* (
    input: NotebookSave,
    caller: Caller,
  ) {
    yield* writable(caller);
    const session = yield* get(input, caller);
    return yield* session.lock.withPermit(
      Effect.gen(function* () {
        yield* get(input, caller);
        if (session.snapshot.outcome === "running" || session.snapshot.kernel === "unknown")
          return yield* new NotebookError({ reason: "busy" });
        if (
          input.revision !== session.snapshot.revision ||
          input.diskHash !== session.snapshot.diskHash
        )
          return yield* new NotebookError({ reason: "stale-revision" });
        const stat = yield* fs
          .stat(session.path)
          .pipe(Effect.mapError(() => new NotebookError({ reason: "not-found" })));
        if (stat.size > NOTEBOOK_LIMITS.bytes)
          return yield* new NotebookError({ reason: "output-limit" });
        const text = yield* fs
          .readFileString(session.path)
          .pipe(Effect.mapError(() => new NotebookError({ reason: "not-found" })));
        const parsed = yield* Effect.try({
          try: () => parseNotebook(text),
          catch: () => new NotebookError({ reason: "invalid-document" }),
        });
        session.reducer = new ExecutionReducer(parsed.document);
        session.snapshot.document = parsed.document;
        session.snapshot.executions = {};
        session.snapshot.diskHash = hash(text);
        session.snapshot.revision++;
        session.snapshot.savedRevision = session.snapshot.revision - (parsed.changed ? 1 : 0);
        changed(session, null, [], true, false);
        return snapshotOf(session);
      }),
    );
  });
  const edit = Effect.fn("NotebookService.edit")(function* (input: NotebookEdit, caller: Caller) {
    yield* writable(caller);
    const session = yield* get(input, caller);
    return yield* session.lock.withPermit(
      Effect.gen(function* () {
        yield* get(input, caller);
        if (session.snapshot.outcome === "running")
          return yield* new NotebookError({ reason: "busy" });
        if (input.revision !== session.snapshot.revision)
          return yield* new NotebookError({ reason: "stale-revision" });
        const parsed = yield* Effect.try({
          try: () => parseNotebook(fingerprintOf(input.document)),
          catch: () => new NotebookError({ reason: "invalid-document" }),
        });
        session.reducer = new ExecutionReducer(parsed.document);
        session.snapshot.document = parsed.document;
        session.snapshot.executions = Object.fromEntries(
          Object.entries(session.snapshot.executions).filter(([id]) =>
            parsed.document.cells.some((cell) => cell.id === id),
          ),
        );
        changed(session, null, [], true);
        return snapshotOf(session);
      }),
    );
  });
  const editCells = Effect.fn("NotebookService.editCells")(function* (
    input: NotebookEditCells,
    caller: Caller,
  ) {
    yield* writable(caller);
    const current = yield* snapshot(input, caller);
    if (current.revision !== input.revision)
      return yield* new NotebookError({ reason: "stale-revision" });
    const document = yield* Effect.try({
      try: () => {
        const document = parseNotebook(fingerprintOf(current.document)).document;
        if (!input.operations.length || input.operations.length > NOTEBOOK_LIMITS.cells)
          throw new Error();
        for (const operation of input.operations) {
          if (operation.type === "insert") {
            if (
              !Number.isInteger(operation.index) ||
              operation.index < 0 ||
              operation.index > document.cells.length
            )
              throw new Error();
            const cell = parseNotebook(fingerprintOf({ ...document, cells: [operation.cell] }))
              .document.cells[0]!;
            if (document.cells.some((c) => c.id === cell.id)) throw new Error();
            document.cells.splice(operation.index, 0, cell);
          } else {
            const index = document.cells.findIndex((c) => c.id === operation.cellId);
            if (index < 0) throw new Error();
            if (operation.type === "update")
              document.cells[index] = { ...document.cells[index]!, source: operation.source };
            else {
              const [cell] = document.cells.splice(index, 1);
              if (operation.type === "move") {
                if (
                  !Number.isInteger(operation.index) ||
                  operation.index < 0 ||
                  operation.index > document.cells.length
                )
                  throw new Error();
                document.cells.splice(operation.index, 0, cell!);
              }
            }
          }
        }
        return document;
      },
      catch: () => new NotebookError({ reason: "invalid-document" }),
    });
    return yield* edit({ ...input, document }, caller);
  });
  const listKernels = Effect.fn("NotebookService.listKernels")(function* (
    input: Pick<NotebookIdentity, "projectId" | "threadId"> & { cursor: number; limit: number },
    caller: Caller,
  ) {
    yield* authorize(caller);
    if (
      !Number.isInteger(input.cursor) ||
      input.cursor < 0 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      return yield* new NotebookError({ reason: "output-limit" });
    const root = yield* rootFor(input);
    const endpoint = yield* config.endpoint(root);
    const specs = yield* transport.listSpecs(endpoint);
    const owned = [...sessions.values()].filter(
      (s) => s.root === root && s.projects.has(input.projectId) && s.kernel,
    );
    const selectedSpecs = specs.slice(input.cursor, input.cursor + input.limit);
    const kernelStart = Math.max(0, input.cursor - specs.length);
    const kernels = owned
      .slice(kernelStart, kernelStart + input.limit - selectedSpecs.length)
      .map((s) => ({
        handle: s.snapshot.handle,
        relativePath: NodePath.relative(root, s.path),
        kernel: s.snapshot.kernel,
        generation: s.snapshot.generation,
        environment: s.snapshot.environment,
        idleDeadline: s.snapshot.idleDeadline,
      }));
    return {
      specs: selectedSpecs,
      kernels,
      nextCursor:
        input.cursor + input.limit < specs.length + owned.length
          ? input.cursor + input.limit
          : null,
    };
  });
  const createLock = Semaphore.makeUnsafe(1);
  const create = Effect.fn("NotebookService.create")(function* (
    input: NotebookCreate,
    caller: Caller,
  ) {
    yield* authorize(caller);
    yield* writable(caller);
    return yield* createLock.withPermit(
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => parseNotebook(fingerprintOf(input.document)),
          catch: () => new NotebookError({ reason: "invalid-document" }),
        });
        const root = yield* rootFor(input);
        const parent = yield* fs
          .realPath(NodePath.resolve(root, NodePath.dirname(input.relativePath)))
          .pipe(Effect.mapError(() => new NotebookError({ reason: "invalid-path" })));
        const relative = NodePath.relative(root, parent);
        if (
          NodePath.isAbsolute(input.relativePath) ||
          !input.relativePath.endsWith(".ipynb") ||
          relative === ".." ||
          relative.startsWith(`..${NodePath.sep}`) ||
          NodePath.isAbsolute(relative)
        )
          return yield* new NotebookError({ reason: "invalid-path" });
        yield* fs
          .writeFileString(
            NodePath.join(parent, NodePath.basename(input.relativePath)),
            fingerprintOf(parsed.document),
            { flag: "wx", mode: 0o600 },
          )
          .pipe(Effect.mapError(() => new NotebookError({ reason: "save-conflict" })));
        return yield* open(input, caller);
      }),
    );
  });
  const acquire = Effect.fn("NotebookService.acquire")(function* (
    input: NotebookLease,
    caller: Caller,
  ) {
    const session = yield* get(input, caller);
    if (!input.leaseId || input.leaseId.length > 128 || session.leases.size >= 128)
      return yield* new NotebookError({ reason: "output-limit" });
    if (!session.leases.has(input.leaseId)) session.leases.set(input.leaseId, Symbol());
    yield* arm(session);
    return snapshotOf(session);
  });
  const close = Effect.fn("NotebookService.close")(function* (
    input: NotebookLease,
    caller: Caller,
  ) {
    const session = yield* get(input, caller);
    session.leases.delete(input.leaseId);
    yield* arm(session, false);
  });
  const subscribe = (input: NotebookSubscribe, caller: Caller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const session = yield* get(input, caller);
        const queue = yield* Queue.dropping<NotebookEvent>(32);
        const leaseId = input.leaseId ?? NodeCrypto.randomUUID();
        const leaseToken = Symbol();
        yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              if (
                !leaseId ||
                leaseId.length > 128 ||
                (session.leases.size >= 128 && !session.leases.has(leaseId))
              )
                throw new NotebookError({ reason: "output-limit" });
              session.leases.set(leaseId, leaseToken);
            },
            catch: () => new NotebookError({ reason: "output-limit" }),
          }),
          () =>
            Effect.gen(function* () {
              session.observers.delete(queue);
              Queue.shutdownUnsafe(queue);
              if (session.leases.get(leaseId) === leaseToken) {
                session.leases.delete(leaseId);
                yield* arm(session);
              }
            }),
        );
        yield* arm(session);
        const initial = yield* Effect.sync(() => {
          const snapshot = snapshotOf(session);
          session.observers.add(queue);
          return snapshot;
        });
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
          if (kernel.scope) yield* Scope.close(kernel.scope, Exit.void);
          yield* transport
            .control(kernel.endpoint, kernel.id, "shutdown")
            .pipe(Effect.andThen(config.released(session.root, kernel.id)), Effect.ignore);
        }),
      { discard: true },
    ),
  );

  return NotebookService.of({
    editCells,
    listKernels,
    readOutputs,
    reload,
    save,
    edit,
    create,
    acquire,
    close,
    open,
    snapshot,
    run,
    execute,
    interrupt: control("interrupt"),
    restart: control("restart"),
    shutdown: control("shutdown"),
    subscribe,
  });
});
export const layer = Layer.effect(NotebookService, make);
