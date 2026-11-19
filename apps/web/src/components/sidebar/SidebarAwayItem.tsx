import { BellIcon, BellOffIcon, BellRingIcon } from "lucide-react";
import { useGT } from "gt-react";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
  MenuSeparator,
  MenuGroupLabel,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const modes = [
  { value: "auto", label: "Auto", detail: "Alert when idle or locked", icon: BellIcon },
  { value: "away", label: "Away", detail: "Always alert", icon: BellRingIcon },
  { value: "here", label: "Here", detail: "Silence input and approval alerts", icon: BellOffIcon },
] as const;

export function SidebarAwayItem() {
  const available = usePrimarySettingsAvailable();
  const mode = usePrimarySettings((settings) => settings.awayMode);
  const idleMinutes = usePrimarySettings((settings) => settings.awayIdleMinutes);
  const updateSettings = useUpdatePrimarySettings();
  const gt = useGT();
  if (!available) return null;
  const selected = modes.find((option) => option.value === mode) ?? modes[0];
  const Icon = selected.icon;
  const label = `Phone alerts: ${selected.label}`;
  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger render={<SidebarMenuButton size="icon" aria-label={label} />}>
                <Icon />
              </MenuTrigger>
            }
          />
          <TooltipPopup side="top">
            {label}: {selected.detail}. Finished and failed alerts always reach your phone.
          </TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="end">
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              const option = modes.find((entry) => entry.value === value);
              if (option) updateSettings({ awayMode: option.value });
            }}
          >
            <MenuGroupLabel>{gt("Phone alerts")}</MenuGroupLabel>
            {modes.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  <span className="flex-1">
                    {option.label}: {option.detail}
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuRadioGroup
            value={String(idleMinutes)}
            onValueChange={(value) => {
              const minutes = [1, 5, 10, 15, 30].find((entry) => String(entry) === value);
              if (minutes) updateSettings({ awayIdleMinutes: minutes });
            }}
          >
            {[1, 5, 10, 15, 30].map((minutes) => (
              <MenuRadioItem key={minutes} value={String(minutes)}>
                <span className="flex items-center gap-2">
                  <span className="flex-1">
                    Auto after {minutes} {minutes === 1 ? "minute" : "minutes"} idle
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
