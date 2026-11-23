import {
  MODEL_ROLE_LEVELS,
  ModelRoleProvider,
  type ModelRoleTarget,
  ModelTier,
  ProviderDriverKind,
  resolveModelRoles,
  THREAD_ROLES,
  THREAD_ROLE_LABELS,
  TIER_PROVIDERS,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ShuffleIcon } from "lucide-react";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ClaudeAI, OpenAI } from "../Icons";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Mounted only while the popover is open, so provider pushes do not re-render the sidebar.
function RoleTargets(props: { targets: ReadonlyArray<ModelRoleTarget> }) {
  const environmentId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  const models = environmentId === null ? undefined : providers.get(environmentId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
      {props.targets.map(({ providerInstanceId, model }) => {
        const known = models
          ?.find((provider) => provider.instanceId === providerInstanceId)
          ?.models.find((entry) => entry.slug === model || entry.aliases?.includes(model));
        return (
          <Tooltip key={providerInstanceId}>
            <TooltipTrigger render={<span className="flex min-w-0 items-center gap-1" />}>
              <ProviderInstanceIcon
                driverKind={ProviderDriverKind.make(providerInstanceId)}
                displayName={providerInstanceId}
                size="compact"
              />
              <span className="truncate">{known?.shortName ?? known?.name ?? model}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{model}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function SidebarRoleProvidersItem() {
  const available = usePrimarySettingsAvailable();
  const modelRoles = usePrimarySettings((settings) => settings.modelRoles);
  const modelTiers = usePrimarySettings((settings) => settings.modelTiers);
  const credits = usePrimarySettings((settings) => settings.providerCreditsApproved);
  const updateSettings = useUpdatePrimarySettings();
  const gt = useGT();
  if (!available) return null;

  const label = gt("Role providers");
  const tierLabel = gt("Tier");
  const providerLabel = gt("Provider");
  const levelLabels = { routine: gt("Routine"), complex: gt("Complex") };
  const providerLabels = { claude: "Claude", both: gt("Both"), codex: "Codex" };
  const roles = resolveModelRoles({ modelRoles, modelTiers });
  const Icon = THREAD_ROLES.every((role) =>
    MODEL_ROLE_LEVELS.every((level) => modelRoles[role][level].provider === "claude"),
  )
    ? ClaudeAI
    : THREAD_ROLES.every((role) =>
          MODEL_ROLE_LEVELS.every((level) => modelRoles[role][level].provider === "codex"),
        )
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
        <PopoverPopup side="top" align="end" width="lg" padding="compact">
          <PopoverTitle>{label}</PopoverTitle>
          <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-1.5 divide-y">
            {THREAD_ROLES.map((role) => {
              const name = THREAD_ROLE_LABELS[role];
              return (
                <div
                  key={role}
                  role="group"
                  aria-label={name}
                  className="col-span-full grid grid-cols-subgrid items-center py-1"
                >
                  <div className="col-span-full text-xs font-medium">{name}</div>
                  {roles
                    .filter((choice) => choice.role === role)
                    .map(({ id, level, targets }) => {
                      const { tier, provider } = modelRoles[role][level];
                      const levelLabel = levelLabels[level];
                      return (
                        <div key={id} className="col-span-full grid grid-cols-subgrid items-center">
                          <div className="text-xs text-muted-foreground">{levelLabel}</div>
                          <RoleTargets targets={targets} />
                          <Select
                            value={tier}
                            onValueChange={(tier) => {
                              if (tier !== null)
                                updateSettings({ modelRoles: { [role]: { [level]: { tier } } } });
                            }}
                          >
                            <SelectTrigger
                              size="compact"
                              variant="ghost"
                              aria-label={`${name} · ${levelLabel} · ${tierLabel}`}
                            >
                              <SelectValue>{`${tierLabel} ${tier}`}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup alignItemWithTrigger={false}>
                              {ModelTier.literals.map((tier) => (
                                <SelectItem
                                  key={tier}
                                  value={tier}
                                >{`${tierLabel} ${tier}`}</SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                          <Select
                            value={provider}
                            onValueChange={(provider) => {
                              if (provider !== null)
                                updateSettings({
                                  modelRoles: { [role]: { [level]: { provider } } },
                                });
                            }}
                          >
                            <SelectTrigger
                              size="compact"
                              variant="ghost"
                              aria-label={`${name} · ${levelLabel} · ${providerLabel}`}
                            >
                              <SelectValue>{providerLabels[provider]}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup alignItemWithTrigger={false}>
                              {ModelRoleProvider.literals.map((provider) => (
                                <SelectItem key={provider} value={provider}>
                                  {providerLabels[provider]}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </div>
                      );
                    })}
                </div>
              );
            })}
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
                  {providerLabels[provider]}
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
