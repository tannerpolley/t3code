import {
  EMPTY_SIDEBAR_LAYOUT,
  type EnvironmentId,
  SidebarLayout,
  type SidebarLayoutMutation,
  type SidebarLayoutRecord,
  type SidebarLayoutUpdate,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { applySidebarLayoutMutation } from "@t3tools/shared/sidebarLayout";

export const SIDEBAR_WRITE_DELAY = 250;
export function usesServerSidebar(capability: boolean | undefined) {
  return capability === true;
}
interface ClientEnvironment {
  server: boolean;
  canWrite: boolean;
  base: SidebarLayoutRecord | null;
  local: SidebarLayout;
  pending: SidebarLayoutMutation[];
  flight: SidebarLayoutMutation[];
  timer: ReturnType<typeof setTimeout> | null;
}
const decodeLocal = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ...SidebarLayout.fields, serverSnapshot: Schema.optional(Schema.Boolean) }),
  ),
);
const localKey = (id: EnvironmentId) => "t3code:sidebar-local:" + id;
export function readLocalSidebarLayout(
  id: EnvironmentId,
  fallback: SidebarLayout,
  options: { forImport?: boolean } = {},
): SidebarLayout {
  try {
    const saved = localStorage.getItem(localKey(id));
    const decoded = saved ? Option.getOrNull(decodeLocal(saved)) : null;
    if (decoded === null || (options.forImport && decoded.serverSnapshot)) return fallback;
    const { serverSnapshot: _, ...layout } = decoded;
    return layout;
  } catch {
    return fallback;
  }
}
function saveLocal(id: EnvironmentId, layout: SidebarLayout, serverSnapshot = false) {
  try {
    // Confirmed server data is a display fallback, never a legacy import candidate.
    const serialized = JSON.stringify(
      serverSnapshot ? { ...layout, serverSnapshot: true } : layout,
    );
    if (localStorage.getItem(localKey(id)) !== serialized)
      localStorage.setItem(localKey(id), serialized);
  } catch {
    /* Storage may be unavailable. */
  }
}
/** One independent write lane per environment. The subscription never discards unacknowledged edits. */
export function createSidebarLayoutClient(
  send: (id: EnvironmentId, input: SidebarLayoutUpdate) => Promise<SidebarLayoutRecord>,
  onError: (error: unknown) => void,
) {
  const environments = new Map<EnvironmentId, ClientEnvironment>();
  const listeners = new Set<() => void>();
  let snapshot = new Map<EnvironmentId, SidebarLayout>();
  const notify = () => {
    snapshot = new Map([...environments].map(([id, entry]) => [id, layout(entry)]));
    for (const listener of listeners) listener();
  };
  const apply = (layout: SidebarLayout, operations: readonly SidebarLayoutMutation[]) =>
    operations.reduce(
      (state, operation) => applySidebarLayoutMutation(state, operation) ?? state,
      layout,
    );
  const layout = (entry: ClientEnvironment) =>
    entry.server
      ? apply(entry.base?.layout ?? entry.local, [...entry.flight, ...entry.pending])
      : entry.local;
  const compact = (operations: SidebarLayoutMutation[]) => {
    const result: SidebarLayoutMutation[] = [];
    for (const operation of operations) {
      if (operation.type === "sectionExpanded" || operation.type === "otherExpanded") {
        const previous = result.at(-1);
        if (
          previous?.type === operation.type &&
          (operation.type === "otherExpanded" ||
            (previous.type === "sectionExpanded" && previous.sectionId === operation.sectionId))
        ) {
          result[result.length - 1] = operation;
          continue;
        }
      }
      if (operation.type === "projectExpanded") {
        const matching = (previous: SidebarLayoutMutation | undefined) =>
          previous?.type === "projectExpanded" &&
          JSON.stringify(previous.projectKeys) === JSON.stringify(operation.projectKeys);
        let opened = operation.expanded;
        while (matching(result.at(-1))) {
          const previous = result.pop()!;
          if (previous.type === "projectExpanded") opened ||= previous.expanded;
        }
        // A prior expansion also opens containing sections; preserve that side effect
        // when the final row state is collapsed.
        if (opened) result.push({ ...operation, expanded: true });
        if (!operation.expanded) result.push(operation);
        continue;
      }
      result.push(operation);
    }
    return result;
  };
  const flush = async (id: EnvironmentId) => {
    const entry = environments.get(id);
    if (!entry || !entry.server || !entry.base || entry.flight.length || !entry.pending.length)
      return;
    entry.flight = compact(entry.pending);
    entry.pending = [];
    try {
      const record = await send(id, { revision: entry.base.revision, operations: entry.flight });
      if (record.revision >= entry.base.revision) {
        entry.base = record;
        saveLocal(id, record.layout, true);
      }
    } catch (error) {
      onError(error);
    } finally {
      entry.flight = [];
      notify();
      if (entry.pending.length) schedule(id, entry);
    }
  };
  const schedule = (id: EnvironmentId, entry: ClientEnvironment) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flush(id);
    }, SIDEBAR_WRITE_DELAY);
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    configure(
      id: EnvironmentId,
      server: boolean,
      fallback: SidebarLayout,
      options: { fallbackReady?: boolean; canWrite?: boolean } = {},
    ) {
      const fallbackReady = options.fallbackReady ?? true;
      const canWrite = options.canWrite ?? true;
      const previous = environments.get(id);
      if (previous && previous.server === server) {
        if (previous.canWrite !== canWrite) {
          previous.canWrite = canWrite;
          if (!canWrite) previous.pending = [];
          notify();
        }
        if (!server) {
          const local = readLocalSidebarLayout(id, fallback);
          if (fallbackReady && local === fallback) saveLocal(id, local);
          if (JSON.stringify(local) !== JSON.stringify(previous.local)) {
            previous.local = local;
            notify();
          }
        }
        return;
      }
      if (previous?.timer) clearTimeout(previous.timer);
      const initial = previous ? layout(previous) : fallback;
      const local = readLocalSidebarLayout(id, initial);
      if (!server && fallbackReady && local === initial) saveLocal(id, local);
      environments.set(id, {
        server,
        canWrite,
        base: null,
        local,
        pending: [],
        flight: [],
        timer: null,
      });
      notify();
    },
    receive(id: EnvironmentId, record: SidebarLayoutRecord) {
      const entry = environments.get(id);
      if (!entry?.server || (entry.base && record.revision <= entry.base.revision)) return;
      entry.base = record;
      saveLocal(id, record.layout, true);
      notify();
      if (entry.pending.length) schedule(id, entry);
    },
    hasPending(id: EnvironmentId) {
      const entry = environments.get(id);
      return !!entry && (entry.pending.length > 0 || entry.flight.length > 0);
    },
    record(id: EnvironmentId) {
      return environments.get(id)?.base ?? null;
    },
    enqueue(id: EnvironmentId, operation: SidebarLayoutMutation) {
      const entry = environments.get(id);
      if (!entry) return false;
      if (entry.server) {
        if (!entry.canWrite) return false;
        entry.pending.push(operation);
        schedule(id, entry);
      } else {
        entry.local = apply(entry.local, [operation]);
        saveLocal(id, entry.local);
      }
      notify();
      return true;
    },
    layouts(ids: Iterable<EnvironmentId>) {
      return new Map(
        [...ids].map((id) => [
          id,
          environments.has(id) ? layout(environments.get(id)!) : EMPTY_SIDEBAR_LAYOUT,
        ]),
      );
    },
    dispose() {
      for (const entry of environments.values()) if (entry.timer) clearTimeout(entry.timer);
      listeners.clear();
    },
  };
}
