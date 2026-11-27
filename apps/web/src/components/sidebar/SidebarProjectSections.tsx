import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  countSidebarAgentStates,
  type SidebarAgentRole,
} from "@t3tools/client-runtime/state/sidebar-families";
import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { memo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useUiStateStore } from "../../uiStateStore";
import {
  formatSidebarAgentStates,
  resolveSidebarAgentState,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function SidebarProjectSectionHeader(props: {
  id: string;
  name: string;
  parent?: string | undefined;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  onContextMenu: (position: { x: number; y: number }, source: ContextMenuSource) => void;
}) {
  return (
    <li className="mt-2 list-none first:mt-0">
      <button
        type="button"
        data-sidebar-row={props.id}
        data-sidebar-parent={props.parent}
        data-testid="sidebar-project-section"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
        }}
        style={{
          paddingInlineStart: `calc(var(--sidebar-row-content-inset) + ${Math.min(props.depth, 3) * 10}px)`,
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <FolderIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-(length:--sidebar-section-text-size,var(--text-sm)) leading-tight font-semibold">
          {props.name}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground",
            props.collapsed && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
}

const ROLE_SECTION_LABELS: Record<SidebarAgentRole, string> = {
  implementation: msg("Implementors"),
  review: msg("Reviewers"),
  design: msg("Designers"),
  writer: msg("Writers"),
  research: msg("Researchers"),
  test: msg("Testers"),
  other: msg("Other agents"),
};

/** Counts the given threads by state, reading the same visit times as their rows. */
export function useSidebarAgentStateSummary(
  threads: readonly EnvironmentThreadShell[],
  short = false,
) {
  const messages = useMessages();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const counts = countSidebarAgentStates(threads, (thread) =>
    resolveSidebarAgentState({
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
    }),
  );
  return formatSidebarAgentStates(counts, messages, short);
}

/** A project's child agents in one role. Its rows name it as their parent. */
export const SidebarRoleSectionHeader = memo(function SidebarRoleSectionHeader(props: {
  id: string;
  sectionKey: string;
  role: SidebarAgentRole;
  parent: string;
  depth: number;
  collapsed: boolean;
  threads: readonly EnvironmentThreadShell[];
  onToggle: (sectionKey: string) => void;
}) {
  const messages = useMessages();
  const summary = useSidebarAgentStateSummary(props.threads);
  return (
    <li className="list-none">
      <button
        type="button"
        data-sidebar-row={props.id}
        data-sidebar-parent={props.parent}
        data-testid="sidebar-role-section"
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggle(props.sectionKey)}
        style={{
          paddingInlineStart: `calc(var(--sidebar-row-content-inset) + 16px + ${Math.min(props.depth, 3) * 10}px)`,
        }}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-(--control-radius) pe-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0", props.collapsed && "-rotate-90")}
        />
        <span className="shrink-0 font-medium">{messages(ROLE_SECTION_LABELS[props.role])}</span>
        <span className="tabular-nums">{props.threads.length}</span>
        <span className="min-w-0 flex-1 truncate text-end tabular-nums">{summary}</span>
      </button>
    </li>
  );
});

export function SidebarProjectSectionNameDialog(props: {
  name?: string | undefined;
  onClose: () => void;
  onSave: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(props.name ?? "");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const gt = useGT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup initialFocus={input} showCloseButton={!saving}>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim() || saving) return;
            setSaving(true);
            if (await props.onSave(name.trim())) props.onClose();
            else setSaving(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.name === undefined ? <T>New section</T> : <T>Rename section</T>}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              ref={input}
              aria-label={gt("Section name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              <T>Save</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
