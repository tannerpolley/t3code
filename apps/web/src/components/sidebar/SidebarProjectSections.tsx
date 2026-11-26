import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
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
