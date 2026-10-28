import type { ScopedThreadRef } from "@t3tools/contracts";
import type { RightPanelSurface } from "~/rightPanelStore";

type CloseGuard = () => Promise<boolean>;
const guards = new Map<string, { guard: CloseGuard; release: () => void }>();
const key = (ref: ScopedThreadRef, path: string) =>
  `${ref.environmentId}\0${ref.threadId}\0${path}`;
export function registerNotebookClose(
  ref: ScopedThreadRef,
  path: string,
  guard: CloseGuard,
  release: () => void,
) {
  guards.set(key(ref, path), { guard, release });
}
export function releaseNotebookSurface(ref: ScopedThreadRef, surface: RightPanelSurface) {
  if (surface.kind !== "file" || surface.attachment) return;
  const id = key(ref, surface.relativePath);
  const adapter = guards.get(id);
  guards.delete(id);
  adapter?.release();
}
export async function allowNotebookClose(
  ref: ScopedThreadRef,
  surfaces: readonly RightPanelSurface[],
) {
  for (const surface of surfaces) {
    if (surface.kind === "file" && !surface.attachment) {
      const guard = guards.get(key(ref, surface.relativePath));
      if (guard) {
        if (!(await guard.guard())) return false;
      }
    }
  }
  return true;
}
