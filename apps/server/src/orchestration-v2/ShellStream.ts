import type {
  ApplicationStoredEvent,
  OrchestrationProjectShell,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import {
  OrchestrationProjectShell as ProjectShellSchema,
  OrchestrationV2ThreadShell as ThreadShellSchema,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

// Shells refetch aggregate state, so token cadence only repeats the same expensive read.
export const SHELL_COALESCE_WINDOW = Duration.seconds(1);

export function buildActiveShellSnapshot(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: OrchestrationV2ThreadShellSnapshot;
  readonly snapshotSequence: number;
}): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: input.threads.schemaVersion,
    snapshotSequence: input.snapshotSequence,
    projects: input.projects,
    threads: input.threads.threads,
    archivedThreads: [],
  };
}

/**
 * One transaction covers the reads so they agree; the threads are decoded after it commits,
 * because the server shares one SQLite connection and decoding a large shell takes longer than
 * reading it.
 */
export const loadShellSnapshotParts = <E1, E2, E3, E4>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly readThreads: Effect.Effect<Effect.Effect<OrchestrationV2ThreadShellSnapshot, E2>, E1>;
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, E3>;
  readonly latestSequence: Effect.Effect<number, E4>;
}) =>
  Effect.gen(function* () {
    const read = yield* input.sql
      .withTransaction(
        Effect.all({
          decodeThreads: input.readThreads,
          projects: input.listProjects,
          snapshotSequence: input.latestSequence,
        }),
      )
      .pipe(NodeSqliteClient.readOnly);
    return {
      projects: read.projects,
      threads: yield* read.decodeThreads,
      snapshotSequence: read.snapshotSequence,
    };
  });

export type ShellApplicationEvent =
  | Pick<
      Extract<ApplicationStoredEvent, { readonly aggregateKind: "project" }>,
      "aggregateKind" | "aggregateId" | "type" | "sequence"
    >
  | {
      readonly sequence: number;
      readonly event: Pick<OrchestrationV2StoredEvent["event"], "threadId">;
    };

/**
 * Retain only the aggregate ID. Native subagent updates refresh their child;
 * the paired parent turn-item event refreshes the parent. One delta per event
 * preserves the strictly increasing sequence watermark clients expect.
 */
export function toShellApplicationEvent(stored: ApplicationStoredEvent): ShellApplicationEvent {
  if ("aggregateKind" in stored) {
    return {
      aggregateKind: stored.aggregateKind,
      aggregateId: stored.aggregateId,
      type: stored.type,
      sequence: stored.sequence,
    };
  }
  const { event } = stored;
  const threadId =
    event.type === "subagent.updated" &&
    event.payload.origin === "provider_native" &&
    event.payload.childThreadId !== null
      ? event.payload.childThreadId
      : event.threadId;
  return { sequence: stored.sequence, event: { threadId } };
}

export function coalesceShellApplicationEvents<A extends ShellApplicationEvent>(
  events: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const latestByAggregate = new Map<string, A>();
  for (const stored of events) {
    const key =
      "aggregateKind" in stored
        ? `project:${stored.aggregateId}`
        : `thread:${stored.event.threadId}`;
    latestByAggregate.set(key, stored);
  }
  return Array.from(latestByAggregate.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/**
 * Prevents a newer marked enrichment from landing before the unmarked authoritative initial
 * snapshot.
 */
export function composeShellStreamWithEnrichment<A, E, R, A2, E2, R2, A3, E3, R3>(input: {
  readonly initial: Stream.Stream<A, E, R>;
  readonly tail: Stream.Stream<A2, E2, R2>;
  readonly enrichment: Stream.Stream<A3, E3, R3>;
}): Stream.Stream<A | A2 | A3, E | E2 | E3, R | R2 | R3> {
  return Stream.concat(input.initial, Stream.merge(input.tail, input.enrichment));
}

const sameProjects = Schema.toEquivalence(Schema.Array(ProjectShellSchema));

export function dedupeShellEnrichment<E, R>(
  stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
): Stream.Stream<OrchestrationV2ShellStreamItem, E, R> {
  return Stream.suspend(() => {
    let previous:
      | {
          readonly projects: ReadonlyArray<OrchestrationProjectShell>;
          readonly roots: ReadonlySet<string>;
        }
      | undefined;
    return stream.pipe(
      Stream.filter((item) => {
        if (item.kind !== "snapshot") {
          if (item.kind === "project.updated" || item.kind === "project.removed")
            previous = undefined;
          return true;
        }
        if (
          item.resolvedRepositoryIdentityRoots === undefined ||
          item.snapshot.threads.length > 0 ||
          item.snapshot.archivedThreads.length > 0
        ) {
          previous = undefined;
          return true;
        }
        const roots = new Set(item.resolvedRepositoryIdentityRoots);
        const prior = previous;
        if (
          prior !== undefined &&
          roots.size === prior.roots.size &&
          [...roots].every((root) => prior.roots.has(root)) &&
          sameProjects(prior.projects, item.snapshot.projects)
        )
          return false;
        previous = { projects: item.snapshot.projects, roots };
        return true;
      }),
    );
  });
}

export function shellStreamItemFromEnrichmentRefresh(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly changes: ReadonlyArray<{ readonly workspaceRoot: string }>;
}): Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  const resolvedRepositoryIdentityRoots = [
    ...new Set(input.changes.map((change) => change.workspaceRoot)),
  ];
  return {
    kind: "snapshot",
    snapshot: {
      ...input.snapshot,
      projects: input.snapshot.projects.filter((project) =>
        resolvedRepositoryIdentityRoots.includes(project.workspaceRoot),
      ),
      threads: [],
      archivedThreads: [],
    },
    resolvedRepositoryIdentityRoots,
  };
}

export function shellStreamItemsFromInitialSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  const authoritative = {
    kind: "snapshot" as const,
    snapshot: input.snapshot,
  };
  if (input.resolvedRepositoryIdentityRoots.length === 0) {
    return [authoritative];
  }
  return [
    authoritative,
    {
      kind: "snapshot" as const,
      snapshot: {
        ...input.snapshot,
        projects: input.snapshot.projects.filter((project) =>
          input.resolvedRepositoryIdentityRoots.includes(project.workspaceRoot),
        ),
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: [...new Set(input.resolvedRepositoryIdentityRoots)],
    },
  ];
}

export function shellStreamItemsFromResumeSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  return shellStreamItemsFromInitialSnapshot(input).filter(
    (item) => item.resolvedRepositoryIdentityRoots !== undefined,
  );
}

const sameThreadShell = Schema.toEquivalence(ThreadShellSchema);

const UNCHANGED_THREAD_SHELL_RESEND_MS = 5_000;

/**
 * A skipped delta leaves the client cursor behind, and a resume replays the events after that
 * cursor. So an unchanged shell is still sent once its last send is
 * `UNCHANGED_THREAD_SHELL_RESEND_MS` old.
 */
export function skipUnchangedThreadShells<A extends OrchestrationV2ShellStreamItem, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> {
  return Stream.suspend(() => {
    const lastSent = new Map<
      OrchestrationV2ThreadShell["id"],
      { readonly thread: OrchestrationV2ThreadShell; readonly sentAt: number }
    >();
    return stream.pipe(
      Stream.mapEffect((item) =>
        Effect.map(Clock.currentTimeMillis, (now): A | null => {
          if (item.kind === "thread.removed") {
            lastSent.delete(item.threadId);
            return item;
          }
          if (item.kind !== "thread.updated") return item;
          const previous = lastSent.get(item.thread.id);
          if (
            previous !== undefined &&
            now - previous.sentAt < UNCHANGED_THREAD_SHELL_RESEND_MS &&
            sameThreadShell(
              { ...item.thread, updatedAt: previous.thread.updatedAt },
              previous.thread,
            )
          )
            return null;
          lastSent.set(item.thread.id, { thread: item.thread, sentAt: now });
          return item;
        }),
      ),
      Stream.filter((item): item is A => item !== null),
    );
  });
}

export function coalesceStoredThreadEvents(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): ReadonlyArray<OrchestrationV2StoredEvent> {
  const latestByThreadId = new Map<string, OrchestrationV2StoredEvent>();
  for (const stored of events) {
    latestByThreadId.set(stored.event.threadId, stored);
  }
  return Array.from(latestByThreadId.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function shellStreamItemFromThreadShell(input: {
  readonly stored: Extract<ShellApplicationEvent, { readonly event: unknown }>;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  if (input.shell !== null) {
    if (input.shell.archivedAt !== null) {
      return {
        kind: "thread.removed",
        sequence: input.stored.sequence,
        location: "active",
        threadId: input.shell.id,
      };
    }
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: "active",
      thread: input.shell,
    };
  }

  return {
    kind: "thread.removed",
    sequence: input.stored.sequence,
    location: "active",
    threadId: input.stored.event.threadId,
  };
}

export function archivedShellStreamItemFromThreadShell(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ArchivedShellStreamItem, { readonly kind: "snapshot" }> | null {
  if (input.shell !== null && input.shell.archivedAt !== null) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      thread: input.shell,
    };
  }
  if (
    input.stored.event.type === "thread.unarchived" ||
    (input.stored.event.type === "thread.deleted" && input.stored.event.payload.archivedAt !== null)
  ) {
    return {
      kind: "thread.removed",
      sequence: input.stored.sequence,
      threadId: input.stored.event.threadId,
    };
  }
  return null;
}
