import { BellIcon, BellOffIcon, BellRingIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
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
  { value: "auto", label: msg("Auto"), detail: msg("Alert when idle or locked"), icon: BellIcon },
  { value: "away", label: msg("Away"), detail: msg("Always alert"), icon: BellRingIcon },
  {
    value: "here",
    label: msg("Here"),
    detail: msg("Silence input and approval alerts"),
    icon: BellOffIcon,
  },
] as const;

export function SidebarAwayItem() {
  const available = usePrimarySettingsAvailable();
  const mode = usePrimarySettings((settings) => settings.awayMode);
  const idleMinutes = usePrimarySettings((settings) => settings.awayIdleMinutes);
  const updateSettings = useUpdatePrimarySettings();
  const gt = useGT();
  const resolve = useMessages();
  if (!available) return null;
  const selected = modes.find((option) => option.value === mode) ?? modes[0];
  const Icon = selected.icon;
  const label = gt("Phone alerts: {mode}", { mode: resolve(selected.label) });
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
            {gt(
              "Phone alerts: {mode}: {detail}. Finished and failed alerts always reach your phone.",
              { mode: resolve(selected.label), detail: resolve(selected.detail) },
            )}
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
                    {resolve(option.label)}: {resolve(option.detail)}
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
                    {gt(
                      "{minutes, plural, one {Auto after {minutes} minute idle} other {Auto after {minutes} minutes idle}}",
                      { minutes },
                    )}
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
