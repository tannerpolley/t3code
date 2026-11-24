import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A repository selection row with its issue count. */
export function IssueTreeRow({
  onSelect,
  count,
  children,
}: {
  readonly onSelect: () => void;
  readonly count: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onSelect}
    >
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
