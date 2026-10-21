// @effect-diagnostics-next-line nodeBuiltinImport:off -- Lease identity must work without adding platform service requirements to callers.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Use the same native path semantics as realpath without adding service requirements.
import * as NodePath from "node:path";

const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * The physical identity of a workspace path. Never normalize lexically before resolving: after a
 * symlink, `..` means the link target's parent, so `/linked/../feature` can be a different
 * directory than `/feature`. A missing tail (a checkout about to be recreated) is appended to its
 * deepest existing ancestor, so the identity is the same before and after the checkout exists.
 */
export function canonicalWorkspacePath(target: string, isWindows: boolean): string {
  const physical = physicalWorkspacePath(target);
  return isWindows ? physical.toLowerCase() : physical;
}

/** The same physical path without case folding, for filesystem and git operations. */
export function physicalWorkspacePath(target: string): string {
  const absolute = NodePath.isAbsolute(target)
    ? target
    : `${process.cwd()}${NodePath.sep}${target}`;
  try {
    return NodeFS.realpathSync.native(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const { root } = NodePath.parse(absolute);
  const parts = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = NodeFS.realpathSync.native(root);
  for (const [index, part] of parts.entries()) {
    if (part === ".") continue;
    // `current` is already physical, so its parent is the physical parent.
    if (part === "..") {
      current = NodePath.dirname(current);
      continue;
    }
    try {
      current = NodeFS.realpathSync.native(NodePath.join(current, part));
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Nothing below a missing directory exists, so the rest can be joined as text.
      return NodePath.join(current, ...parts.slice(index));
    }
  }
  return current;
}
