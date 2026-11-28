import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function SidebarCollapsibleSection(props: {
  readonly id: string;
  readonly parent: string;
  readonly depth: number;
  readonly familyDepth?: number;
  readonly collapsed: boolean;
  readonly onToggle: (id: string, all: boolean) => void;
  readonly label: string;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  const offset = Math.min(props.depth, 3) * 10 + (props.familyDepth ?? 0) * 12;
  return (
    <button
      type="button"
      data-sidebar-row={props.id}
      data-sidebar-parent={props.parent}
      data-testid={props.testId}
      aria-expanded={!props.collapsed}
      onClick={(event) => props.onToggle(props.id, event.altKey)}
      style={{ paddingInlineStart: `calc(var(--sidebar-row-content-inset) + 16px + ${offset}px)` }}
      className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-(--control-radius) pe-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0", props.collapsed && "-rotate-90")}
      />
      <span className="shrink-0 font-medium">{props.label}</span>
      {props.children}
    </button>
  );
}
