import { createLucideIcon } from "lucide-react";

/** A checkout's branch glyph: the worktree mark, drawn like Lucide's own icons. */
export const WorktreeIcon = createLucideIcon("worktree", [
  ["circle", { cx: "7", cy: "5", r: "3", key: "top" }],
  ["circle", { cx: "7", cy: "19", r: "3", key: "bottom" }],
  ["circle", { cx: "17", cy: "10", r: "3", key: "branch" }],
  ["path", { d: "M7 8v8", key: "trunk" }],
  ["path", { d: "M7 15h4l3.9-2.9", key: "fork" }],
]);
