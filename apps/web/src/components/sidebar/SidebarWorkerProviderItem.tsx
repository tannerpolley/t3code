import { ShuffleIcon } from "lucide-react";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { WORKER_PROVIDER_OPTIONS } from "../WorkerProviderSelect";
import { ClaudeAI, OpenAI } from "../Icons";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarWorkerProviderItem() {
  const available = usePrimarySettingsAvailable();
  const mode = usePrimarySettings((settings) => settings.workerProvider);
  const updateSettings = useUpdatePrimarySettings();
  if (!available) return null;
  const label = `Worker provider: ${WORKER_PROVIDER_OPTIONS.find((option) => option.value === mode)?.label}`;
  return (
    <SidebarMenuItem className="ms-auto shrink-0 [.ml-auto+&]:ms-0">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger render={<SidebarMenuButton size="icon" aria-label={label} />}>
                {mode === "mixed" ? <ShuffleIcon /> : mode === "claude" ? <ClaudeAI /> : <OpenAI />}
              </MenuTrigger>
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="end">
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              const option = WORKER_PROVIDER_OPTIONS.find((option) => option.value === value);
              if (option) updateSettings({ workerProvider: option.value });
            }}
          >
            {WORKER_PROVIDER_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  <span className="flex-1">{option.label}</span>
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
