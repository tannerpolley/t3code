import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  type RefObject,
  useEffect,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useStableCallback } from "../../hooks/useStableCallback";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  // React 19.2.6 does not refresh Effect Events in memoized components.
  const handleDrop = useStableCallback(onDrop);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
    handleDrop,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
) {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  setGhost({ x: point.x, y: point.y, ...label });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const target = findDropTarget(point);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}

/**
 * Context drag for rows that have no sort gesture of their own (the Projects view): once the
 * pointer moves a few pixels the row follows it as a ghost, and releasing over a composer adds
 * the thread. The click that ends a drag is swallowed so the row doesn't also open.
 */
export function useThreadContextPointerDrag(
  getDrag: () => { readonly threads: ReadonlyArray<ScopedThreadRef>; readonly title: string },
) {
  const dragged = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    cleanup.current?.();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    dragged.current = false;
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const point = { x: next.clientX, y: next.clientY };
      if (!dragged.current && Math.hypot(point.x - start.x, point.y - start.y) < 6) return;
      dragged.current = true;
      const { threads, title } = getDrag();
      moveThreadContextDrag(point, { title, count: threads.length });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      endThreadContextDrag();
      cleanup.current = null;
    };
    const up = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (dragged.current)
        dropThreadContext({ x: next.clientX, y: next.clientY }, getDrag().threads);
      stop();
    };
    const cancel = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      dragged.current = false;
      stop();
    };
    cleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };
  const onClickCapture = (event: MouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  return { onPointerDown, onClickCapture };
}
