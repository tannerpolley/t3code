import { MessageCircleQuestionIcon } from "lucide-react";
import type { CSSProperties } from "react";

import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Ask mode reflects the inverse of the primary server's automatic-answer setting. */
export function SidebarAskModeItem() {
  const available = usePrimarySettingsAvailable();
  const on = usePrimarySettings((settings) => !settings.dontAskMode);
  const updateSettings = useUpdatePrimarySettings();
  if (!available) return null;
  const label = on
    ? "Ask mode: on (agents can ask you questions)"
    : "Ask mode: off (agents decide without asking)";
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-pressed={on}
              // A clicked button keeps focus, so a later Space or Enter meant for the composer
              // would silently flip Ask mode. Keyboard focus via Tab is unaffected.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => updateSettings({ dontAskMode: on })}
              size="icon"
              // Orange matches the sidebar's questions waiting for you.
              style={
                on
                  ? ({ "--sidebar-icon-color": "var(--warning-foreground)" } as CSSProperties)
                  : undefined
              }
            >
              <MessageCircleQuestionIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top" className="max-w-64">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{label}</span>
            <span className="text-muted-foreground">
              {on
                ? "Turn off when you step away: questions get their recommended option and approvals are granted."
                : "Questions get their recommended option and approvals are granted. Turn on to answer them yourself."}
            </span>
          </div>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
