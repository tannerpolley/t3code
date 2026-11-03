import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Indentation for repository rows and rows nested under them; the tree has no boxes. */
const LEVEL_PADDING = ["ps-2", "ps-6"] as const;

/** One disclosure row of the issue tree: chevron, label, and a right-aligned count. */
export function IssueTreeRow({
  level,
  expanded,
  onToggle,
  controls,
  count,
  className,
  children,
}: {
  readonly level: 0 | 1;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly controls: string;
  readonly count: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-controls={controls}
      aria-expanded={expanded}
      className={cn(
        "flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-md pe-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        LEVEL_PADDING[level],
        className,
      )}
      onClick={onToggle}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
          expanded && "rotate-90",
        )}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

/** A small uppercase tag beside a repository name. */
export function IssueTreeTag({ children }: { readonly children: ReactNode }) {
  return (
    <span className="shrink-0 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}
