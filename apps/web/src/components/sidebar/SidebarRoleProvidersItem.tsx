import { DEFAULT_SERVER_SETTINGS, resolveModelRoles, TIER_PROVIDERS } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ShuffleIcon } from "lucide-react";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { ClaudeAI, OpenAI } from "../Icons";
import { RoleProviderToggle } from "../RoleProviderToggle";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const roles = resolveModelRoles(DEFAULT_SERVER_SETTINGS);

export function SidebarRoleProvidersItem() {
  const available = usePrimarySettingsAvailable();
  const settings = usePrimarySettings((settings) => settings.modelRoles);
  const credits = usePrimarySettings((settings) => settings.providerCreditsApproved);
  const updateSettings = useUpdatePrimarySettings();
  const gt = useGT();
  if (!available) return null;

  const label = gt("Role providers");
  const Icon = roles.every(({ id }) => settings[id].provider === "claude")
    ? ClaudeAI
    : roles.every(({ id }) => settings[id].provider === "codex")
      ? OpenAI
      : ShuffleIcon;
  return (
    <SidebarMenuItem className="ms-auto shrink-0 [.ml-auto+&]:ms-0">
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger render={<SidebarMenuButton size="icon" aria-label={label} />}>
                <Icon />
              </PopoverTrigger>
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="end" width="md">
          <PopoverTitle>{label}</PopoverTitle>
          <div className="mt-3 grid gap-1.5">
            {roles.map(({ id, name }) => (
              <div key={id} className="flex items-center justify-between gap-2 text-sm">
                <span>{name}</span>
                <RoleProviderToggle
                  label={name}
                  value={settings[id].provider}
                  onChange={(provider) => updateSettings({ modelRoles: { [id]: { provider } } })}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 border-t pt-3">
            <p className="text-sm text-muted-foreground">
              {gt("Approve using credits when weekly usage runs low.")}
            </p>
            {TIER_PROVIDERS.map((provider) => (
              <label key={provider} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  {provider === "claude" ? (
                    <ClaudeAI className="size-4" />
                  ) : (
                    <OpenAI className="size-4" />
                  )}
                  {provider === "claude" ? "Claude" : "Codex"}
                </span>
                <Switch
                  size="sm"
                  checked={credits[provider]}
                  onCheckedChange={(approved) =>
                    updateSettings({ providerCreditsApproved: { [provider]: approved } })
                  }
                />
              </label>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
