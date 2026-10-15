import { useAtomValue } from "@effect/atom-react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveShortcutCommand } from "~/keybindings";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { toastManager } from "../ui/toast";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo, useEffect, useEffectEvent } from "react";
import {
  ISSUES_PANEL_REF,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { issueReferenceCopyTarget } from "./issueDetailActions.logic";

/** The generic Copy reference command follows the issue currently open beside the thread. */
export function useIssueReferenceCopyTarget(threadRef: ScopedThreadRef | null) {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  return useMemo(
    () => issueReferenceCopyTarget(surface?.kind === "issue" ? surface : null),
    [surface],
  );
}

/** The Issues page owns one shortcut listener, even when both responsive panes are mounted. */
export function useIssuePageCopyShortcut() {
  const target = useIssueReferenceCopyTarget(ISSUES_PANEL_REF);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { copyToClipboard } = useCopyToClipboard({
    target: "issue link",
    onCopy: () => toastManager.add({ type: "success", title: "Issue link copied" }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (target === null || event.defaultPrevented || isCommandPaletteOpen()) return;
    if (
      resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      }) !== "thread.copyReference"
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) copyToClipboard(target.value);
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
