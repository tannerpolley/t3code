import { useAtomValue } from "@effect/atom-react";
import {
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import { sidebarRoleLabels } from "@t3tools/client-runtime/sidebar-row-model";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AuthSettingsWriteScope,
  DelegationComplexity,
  DelegationModelRole,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type RoleModel,
  type ServerProvider,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { type ReactElement, useState } from "react";
import { useMergedSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { roleModelChoices } from "~/modelSelection";
import { useEnvironment } from "~/state/environments";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

function RoleSelect({
  label,
  value,
  choices,
  disabled,
  selectedLabel,
  leadingIcon,
  onPick,
}: {
  label: string;
  value: string;
  choices: ReadonlyArray<{ id: string; label: string }>;
  disabled: boolean;
  selectedLabel?: string;
  leadingIcon?: ReactElement | undefined;
  onPick: (value: string) => void;
}) {
  const displayLabel =
    selectedLabel ?? choices.find((choice) => choice.id === value)?.label ?? value;
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onPick(next);
      }}
    >
      <SelectTrigger size="compact" variant="ghost" aria-label={label} className="min-w-0">
        {leadingIcon}
        <SelectValue title={displayLabel}>{displayLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function RoleModelRow({
  roleLabel,
  level,
  providers,
  choices,
  pick,
  readOnly,
  onSave,
}: {
  roleLabel: string;
  level: DelegationComplexity;
  providers: ReadonlyArray<ServerProvider>;
  choices: ReturnType<typeof roleModelChoices>;
  pick: RoleModel | undefined;
  readOnly: boolean;
  onSave: (pick: RoleModel | null, onSettled: () => void) => void;
}) {
  const gt = useGT();
  const [saving, setSaving] = useState(false);
  const levelLabel =
    level === "routine"
      ? gt("Routine", { $context: "delegation complexity" })
      : gt("Complex", { $context: "delegation complexity" });
  const provider = providers.find((entry) => entry.instanceId === pick?.instanceId);
  const model = provider?.models.find((entry) => entry.slug === pick?.model);
  const providerChoice = choices.find(({ entry }) => entry.instanceId === pick?.instanceId);
  const models = providerChoice?.models ?? [];
  const selected = models.find((entry) => entry.slug === pick?.model);
  const unavailable = pick && !selected;
  const effort = selected
    ? model?.capabilities?.optionDescriptors?.find(isReasoningControl)
    : undefined;
  const effortChoices =
    effort?.type === "select"
      ? selectableProviderOptionChoices(effort)
      : effort?.type === "boolean"
        ? [
            { id: "true", label: gt("On", { $context: "option state" }) },
            { id: "false", label: gt("Off", { $context: "option state" }) },
          ]
        : [];
  const pickedEffort = pick?.effort;
  const effortValue =
    pickedEffort === "orchestrator"
      ? "orchestrator"
      : pickedEffort !== undefined && pickedEffort.id === effort?.id
        ? `option:${pickedEffort.value}`
        : "";
  const providerChoices = choices.map(({ entry }) => ({
    id: entry.instanceId,
    label: entry.displayName,
  }));
  const disabled = readOnly || saving;
  const save = (next: RoleModel | null) => {
    setSaving(true);
    onSave(next, () => setSaving(false));
  };
  return (
    <div className="grid grid-cols-[minmax(0,4rem)_minmax(0,1fr)] items-center gap-1">
      <div className="text-muted-foreground text-xs">{levelLabel}</div>
      <div className={pick ? "grid grid-cols-[1fr_1fr_1.25fr] items-center gap-1" : "flex"}>
        <RoleSelect
          label={gt("{role} ({level}) provider", { role: roleLabel, level: levelLabel })}
          value={pick?.instanceId ?? ""}
          disabled={disabled}
          {...(provider && !providerChoices.some((entry) => entry.id === provider.instanceId)
            ? { selectedLabel: resolveProviderInstanceDisplayName(provider) }
            : {})}
          leadingIcon={
            provider ? (
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={resolveProviderInstanceDisplayName(provider)}
                accentColor={providerChoice?.entry.accentColor}
                acpRegistryAgentId={providerChoice?.entry.acpRegistryAgentId}
                acpRegistryIconUrl={providerChoice?.entry.acpRegistryIconUrl}
                showBadge={Boolean(providerChoice?.entry.accentColor)}
                size="compact"
              />
            ) : undefined
          }
          choices={[{ id: "", label: gt("Orchestrator decides") }, ...providerChoices]}
          onPick={(id) => {
            if (id === "") {
              save(null);
              return;
            }
            const next = choices.find(({ entry }) => entry.instanceId === id);
            const nextModel = next?.models.find((model) => model.isDefault) ?? next?.models[0];
            if (next && nextModel)
              save({
                instanceId: next.entry.instanceId,
                model: nextModel.slug,
                effort: "orchestrator",
              });
          }}
        />
        {pick ? (
          <RoleSelect
            label={gt("{role} ({level}) model", { role: roleLabel, level: levelLabel })}
            value={pick.model}
            disabled={disabled || models.length === 0}
            {...(unavailable
              ? { selectedLabel: `${model?.name ?? pick.model} · ${gt("Unavailable")}` }
              : {})}
            choices={models.map((entry) => ({
              id: entry.slug,
              label: entry.name,
            }))}
            onPick={(model) =>
              save({
                instanceId: pick.instanceId,
                model,
                // Another model's effort values may not apply; a model default choice still does.
                ...(pick.effort === undefined ? {} : { effort: "orchestrator" }),
              })
            }
          />
        ) : null}
        {pick && selected ? (
          <RoleSelect
            label={gt("{role} ({level}) effort", { role: roleLabel, level: levelLabel })}
            value={effortValue}
            disabled={disabled}
            choices={[
              { id: "", label: gt("Model default") },
              { id: "orchestrator", label: gt("Orchestrator decides") },
              ...effortChoices.map(({ id, label }) => ({ id: `option:${id}`, label })),
            ]}
            onPick={(id) => {
              const option = effortChoices.find((choice) => `option:${choice.id}` === id);
              const nextEffort =
                id === "orchestrator"
                  ? id
                  : effort && option
                    ? {
                        id: effort.id,
                        value: effort.type === "boolean" ? option.id === "true" : option.id,
                      }
                    : undefined;
              save({
                instanceId: pick.instanceId,
                model: pick.model,
                ...(nextEffort === undefined ? {} : { effort: nextEffort }),
              });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function RoleModelsEditor({
  environmentId,
  readOnly,
}: {
  environmentId: EnvironmentId;
  readOnly: boolean;
}) {
  const messages = useMessages();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const environmentLabel = useEnvironment(environmentId)?.label;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const pickerSettings = useMergedSettings(settings ?? DEFAULT_SERVER_SETTINGS);
  const choices = settings ? roleModelChoices(pickerSettings, providers) : [];
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <>
      {environmentLabel ? (
        <div className="mt-1 truncate text-muted-foreground text-xs">{environmentLabel}</div>
      ) : null}
      <div className="mt-2 max-h-[min(32rem,calc(var(--available-height)-3rem))] divide-y divide-border/60 overflow-y-auto">
        {DelegationModelRole.literals.map((role) => {
          const roleLabel = messages(sidebarRoleLabels[role]);
          return (
            <div key={role} role="group" aria-label={roleLabel} className="py-1.5">
              <div className="text-xs font-medium">{roleLabel}</div>
              {DelegationComplexity.literals.map((level) => (
                <RoleModelRow
                  key={level}
                  roleLabel={roleLabel}
                  level={level}
                  providers={providers}
                  choices={choices}
                  pick={settings?.roleModels[role]?.[level]}
                  readOnly={readOnly || !canWrite || settings === null}
                  onSave={(pick, onSettled) =>
                    updateSettings(
                      { roleModels: { [role]: { [level]: pick } } },
                      { onSaved: onSettled, onFailed: onSettled },
                    )
                  }
                />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function RoleModelsPopover({
  environmentId,
  trigger,
  readOnly = false,
  tooltip = false,
}: {
  environmentId: EnvironmentId;
  trigger: ReactElement;
  readOnly?: boolean;
  tooltip?: boolean;
}) {
  const gt = useGT();
  const label = gt("Role models");
  const popoverTrigger = <PopoverTrigger render={trigger} aria-label={label} />;
  return (
    <Popover>
      {tooltip ? <SharedTooltipTrigger render={popoverTrigger} label={label} /> : popoverTrigger}
      <PopoverPopup side="top" align="end" width="xl" padding="compact">
        <PopoverTitle>{label}</PopoverTitle>
        <RoleModelsEditor key={environmentId} environmentId={environmentId} readOnly={readOnly} />
      </PopoverPopup>
    </Popover>
  );
}
