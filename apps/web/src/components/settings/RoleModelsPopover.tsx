import { useAtomValue } from "@effect/atom-react";
import {
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import { sidebarRoleLabels } from "@t3tools/client-runtime/sidebar-row-model";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AuthSettingsWriteScope,
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
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

function RoleSelect({
  label,
  value,
  choices,
  disabled,
  selectedLabel,
  onPick,
}: {
  label: string;
  value: string;
  choices: ReadonlyArray<{ id: string; label: string }>;
  disabled: boolean;
  selectedLabel?: string;
  onPick: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onPick(next);
      }}
    >
      <SelectTrigger size="compact" variant="ghost" aria-label={label} className="min-w-0">
        <SelectValue>
          {selectedLabel ?? choices.find((choice) => choice.id === value)?.label ?? value}
        </SelectValue>
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
  role,
  providers,
  choices,
  pick,
  readOnly,
  onSave,
}: {
  role: DelegationModelRole;
  providers: ReadonlyArray<ServerProvider>;
  choices: ReturnType<typeof roleModelChoices>;
  pick: RoleModel | undefined;
  readOnly: boolean;
  onSave: (pick: RoleModel | null, onSettled: () => void) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [saving, setSaving] = useState(false);
  const roleLabel = messages(sidebarRoleLabels[role]);
  const provider = providers.find((entry) => entry.instanceId === pick?.instanceId);
  const model = provider?.models.find((entry) => entry.slug === pick?.model);
  const models = choices.find(({ entry }) => entry.instanceId === pick?.instanceId)?.models ?? [];
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
    <div role="group" aria-label={roleLabel} className="py-1.5">
      <div className="text-xs font-medium">{roleLabel}</div>
      <div className={pick ? "grid grid-cols-3 items-center gap-1" : "flex"}>
        <RoleSelect
          label={gt("{role} provider", { role: roleLabel })}
          value={pick?.instanceId ?? ""}
          disabled={disabled}
          {...(provider && !providerChoices.some((entry) => entry.id === provider.instanceId)
            ? { selectedLabel: resolveProviderInstanceDisplayName(provider) }
            : {})}
          choices={[{ id: "", label: gt("Orchestrator decides") }, ...providerChoices]}
          onPick={(id) => {
            if (id === "") {
              save(null);
              return;
            }
            const next = choices.find(({ entry }) => entry.instanceId === id);
            const nextModel = next?.models.find((model) => model.isDefault) ?? next?.models[0];
            if (next && nextModel)
              save({ instanceId: next.entry.instanceId, model: nextModel.slug });
          }}
        />
        {pick ? (
          <RoleSelect
            label={gt("{role} model", { role: roleLabel })}
            value={pick.model}
            disabled={disabled || models.length === 0}
            {...(unavailable
              ? { selectedLabel: `${model?.name ?? pick.model} · ${gt("Unavailable")}` }
              : {})}
            choices={models.map((entry) => ({
              id: entry.slug,
              label: entry.name,
            }))}
            onPick={(model) => save({ instanceId: pick.instanceId, model })}
          />
        ) : null}
        {pick && effort && effortChoices.length > 0 ? (
          <RoleSelect
            label={gt("{role} effort", { role: roleLabel })}
            value={pick.effort?.id === effort.id ? String(pick.effort.value) : ""}
            disabled={disabled}
            choices={[{ id: "", label: gt("Model default") }, ...effortChoices]}
            onPick={(id) =>
              save({
                instanceId: pick.instanceId,
                model: pick.model,
                ...(id === ""
                  ? {}
                  : {
                      effort: {
                        id: effort.id,
                        value: effort.type === "boolean" ? id === "true" : id,
                      },
                    }),
              })
            }
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
      <div className="mt-2 divide-y divide-border/60">
        {DelegationModelRole.literals.map((role) => (
          <RoleModelRow
            key={role}
            role={role}
            providers={providers}
            choices={choices}
            pick={settings?.roleModels[role]}
            readOnly={readOnly || !canWrite || settings === null}
            onSave={(pick, onSettled) =>
              updateSettings(
                { roleModels: { [role]: pick } },
                { onSaved: onSettled, onFailed: onSettled },
              )
            }
          />
        ))}
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
      <PopoverPopup side="top" align="end" width="lg" padding="compact">
        <PopoverTitle>{label}</PopoverTitle>
        <RoleModelsEditor key={environmentId} environmentId={environmentId} readOnly={readOnly} />
      </PopoverPopup>
    </Popover>
  );
}
