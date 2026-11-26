import {
  ModelRole,
  ModelRoleLevel,
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type SelectProviderOptionDescriptor,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection, SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

const ROLE_LABELS = {
  orchestrator: msg("Orchestrator"),
  designer: msg("Designer"),
  implementor: msg("Implementor"),
  reviewer: msg("Reviewer"),
  writer: msg("Writer"),
} satisfies Record<ModelRole, ReturnType<typeof msg>>;

const LEVEL_LABELS = {
  routine: msg("Routine", { $context: "task complexity" }),
  complex: msg("Complex", { $context: "task complexity" }),
} satisfies Record<ModelRoleLevel, ReturnType<typeof msg>>;

const noInstance = ProviderInstanceId.make("unconfigured-model-role");

export function ModelRolesSettings({
  environmentId,
  providers,
  disabled,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  disabled: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const gt = useGT();
  const m = useMessages();
  const entries = providerInstanceEntriesFor(providers, settings, null);

  return (
    <SettingsSection title={gt("Model role presets")}>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        <T>Delegated tasks use these presets when the caller specifies a role without a target.</T>
      </p>
      <SettingsGroup>
        {ModelRole.literals.flatMap((role) =>
          ModelRoleLevel.literals.map((level) => {
            const label = gt("{role} · {level}", {
              role: m(ROLE_LABELS[role]),
              level: m(LEVEL_LABELS[level]),
            });
            const saved = settings.modelRoles[role]?.[level];
            const selection = saved?.instanceId === undefined ? null : saved;
            const instance = entries.find((entry) => entry.instanceId === selection?.instanceId);
            const model = instance?.models.find((entry) => entry.slug === selection?.model);
            const reasoning = model?.capabilities?.optionDescriptors?.find(
              (descriptor): descriptor is SelectProviderOptionDescriptor =>
                descriptor.type === "select" &&
                (descriptor.role === "reasoning" ||
                  ["reasoningEffort", "effort", "thinking"].includes(descriptor.id)),
            );
            const effortChoices =
              reasoning?.options.filter(
                (choice) =>
                  choice.id !== "default" && !reasoning.promptInjectedValues?.includes(choice.id),
              ) ?? [];
            const effort = selection?.options?.find((option) => option.id === reasoning?.id)?.value;
            const effortLabel =
              effortChoices.find((choice) => choice.id === effort)?.label ??
              (typeof effort === "string" && effort !== "default" ? effort : gt("Default effort"));
            const save = (next: ModelSelection | null) =>
              updateSettings({ setModelRole: { role, level, selection: next } });

            return (
              <SettingsRow
                key={`${role}:${level}`}
                title={label}
                control={
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={
                        selection?.instanceId ?? entries[0]?.instanceId ?? noInstance
                      }
                      model={selection?.model ?? ""}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={getCustomModelOptionsByInstance(
                        settings,
                        providers,
                        selection?.instanceId,
                        selection?.model,
                      )}
                      isComposerOwned={false}
                      disabled={disabled}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      {...(selection === null ? { triggerLabel: gt("Inherit parent model") } : {})}
                      triggerAriaLabel={gt("Model for {preset}", { preset: label })}
                      onInstanceModelChange={(instanceId, model) => {
                        if (instanceId !== selection?.instanceId || model !== selection.model) {
                          save({ instanceId, model });
                        }
                      }}
                    />
                    {selection && reasoning && effortChoices.length > 0 ? (
                      <Select<string>
                        value={typeof effort === "string" && effort !== "default" ? effort : ""}
                        disabled={disabled}
                        onValueChange={(value) => {
                          if (value !== null) {
                            save({
                              ...selection,
                              options: value === "" ? [] : [{ id: reasoning.id, value }],
                            });
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={gt("Effort for {preset}", { preset: label })}
                        >
                          <SelectValue>{effortLabel}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          <SelectItem value="">{gt("Default effort")}</SelectItem>
                          {effortChoices.map((choice) => (
                            <SelectItem key={choice.id} value={choice.id}>
                              {choice.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : null}
                    {selection ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={disabled}
                        aria-label={gt("Clear preset for {preset}", { preset: label })}
                        onClick={() => save(null)}
                      >
                        <T>Clear preset</T>
                      </Button>
                    ) : null}
                  </div>
                }
              />
            );
          }),
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
