// @effect-diagnostics-next-line nodeBuiltinImport:off -- Lease identity must work without adding platform service requirements to callers.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Use the same native path semantics as realpath without adding service requirements.
import * as NodePath from "node:path";

export function canonicalWorkspacePath(target: string, isWindows: boolean): string {
  const resolved = NodePath.resolve(target);
  let ancestor = resolved;
  while (true) {
    try {
      // Missing checkouts must use the same identity before and after recreation.
      const canonical = NodePath.join(
        NodeFS.realpathSync.native(ancestor),
        NodePath.relative(ancestor, resolved),
      );
      return isWindows ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
