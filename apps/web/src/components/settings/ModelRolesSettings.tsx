import {
  DEFAULT_MODEL_TIERS,
  MAX_MODEL_NOTE_LENGTH,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  ModelRoleEffort,
  ModelTier,
  THREAD_ROLES,
  ProviderDriverKind,
  resolveModelRoles,
  TIER_PROVIDERS,
  TIER_PROVIDER_INSTANCES,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { threadRoleLabel } from "../threadRoleDisplay";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { RoleProviderToggle } from "../RoleProviderToggle";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ForkSettingsRow as SettingsRow } from "./ForkSettingsRow";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ModelRolesSection() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  const resolve = useMessages();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environmentId === null ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
    null,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const roles = resolveModelRoles(settings);
  const levelLabels = { routine: gt("Routine"), complex: gt("Complex") };
  const tierLabel = gt("Tier");
  const effortLabel = gt("Effort");
  const effortLabels: Record<ModelRoleEffort, string> = {
    default: gt("Default"),
    low: gt("Low"),
    medium: gt("Medium"),
    high: gt("High"),
    xhigh: gt("Extra high"),
    max: gt("Maximum"),
  };
  const resetTiers = Object.fromEntries(
    ModelTier.literals.map((tier) => [
      tier,
      {
        claude: { model: DEFAULT_MODEL_TIERS[tier].claude },
        codex: { model: DEFAULT_MODEL_TIERS[tier].codex },
      },
    ]),
  );
  const hasCustomTier = ModelTier.literals.some((tier) =>
    TIER_PROVIDERS.some(
      (provider) =>
        settings.modelTiers[tier][provider].model !== DEFAULT_MODEL_TIERS[tier][provider],
    ),
  );

  return (
    <SettingsSection title={gt("Model roles")}>
      <SettingsRow
        {...searchableSetting("model-tiers")}
        title={gt("Model tiers and notes")}
        description={gt(
          "Roles share the models in each tier. Agents see your notes when choosing a model.",
        )}
        serverScoped
        settingKeys={["modelTiers"]}
        resetAction={
          hasCustomTier ? (
            <SettingResetButton
              ariaLabel={gt("Reset model tiers to default")}
              onClick={() => updateSettings({ modelTiers: resetTiers })}
            />
          ) : null
        }
      />
      {ModelTier.literals.map((tier) => (
        <SettingsRow
          key={tier}
          title={`${tierLabel} ${tier}`}
          serverScoped
          settingKeys={["modelTiers"]}
          control={
            <div className="grid min-w-0 gap-2">
              {TIER_PROVIDERS.map((provider) => {
                const instanceId = TIER_PROVIDER_INSTANCES[provider];
                const { model, note } = settings.modelTiers[tier][provider];
                const providerName = provider === "claude" ? "Claude" : "Codex";
                return (
                  <div
                    key={provider}
                    className="flex min-w-0 flex-wrap items-center justify-end gap-2"
                  >
                    <span className="text-sm">{providerName}</span>
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={instanceId}
                      model={model}
                      lockedProvider={ProviderDriverKind.make(instanceId)}
                      instanceEntries={entries.filter((entry) => entry.instanceId === instanceId)}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onInstanceModelChange={(_, model) =>
                        updateSettings({ modelTiers: { [tier]: { [provider]: { model } } } })
                      }
                    />
                    <div className="min-w-40 flex-1">
                      <DraftInput
                        aria-label={`${providerName} · ${tierLabel} ${tier} · ${gt("Model note")}`}
                        size="sm"
                        maxLength={MAX_MODEL_NOTE_LENGTH}
                        placeholder={gt("Strengths and weaknesses")}
                        value={note}
                        onCommit={(next) =>
                          updateSettings({
                            modelTiers: { [tier]: { [provider]: { note: next.trim() } } },
                          })
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          }
        />
      ))}
      <SettingsRow
        {...searchableSetting("model-roles")}
        title={gt("Model roles")}
        description={gt("Set the tier, provider, and effort for each level of a delegation role.")}
        serverScoped
        settingKeys={["modelRoles"]}
      />
      {THREAD_ROLES.map((name) => (
        <div key={name} role="group" aria-label={threadRoleLabel(name, resolve)}>
          {roles
            .filter((role) => role.role === name)
            .map((role) => {
              const { level } = role;
              const label = `${threadRoleLabel(name, resolve)} · ${levelLabels[level]}`;
              const { tier, provider, effort } = settings.modelRoles[name][level];
              return (
                <SettingsRow
                  key={role.id}
                  title={label}
                  serverScoped
                  settingKeys={["modelRoles"]}
                  control={
                    <div className="flex min-w-0 flex-col items-end gap-2">
                      <DraftInput
                        aria-label={`${label} · ${gt("Role description")}`}
                        size="sm"
                        maxLength={MAX_MODEL_ROLE_DESCRIPTION_LENGTH}
                        placeholder={gt("When to use this role")}
                        value={role.description}
                        onCommit={(next) =>
                          updateSettings({
                            modelRoles: { [name]: { [level]: { description: next.trim() } } },
                          })
                        }
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Select
                          value={String(tier)}
                          onValueChange={(value) => {
                            const tier = ModelTier.literals.find((tier) => String(tier) === value);
                            if (tier !== undefined)
                              updateSettings({ modelRoles: { [name]: { [level]: { tier } } } });
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            variant="ghost"
                            aria-label={`${label} · ${tierLabel}`}
                          >
                            <SelectValue>{`${tierLabel} ${tier}`}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {ModelTier.literals.map((tier) => (
                              <SelectItem
                                key={tier}
                                value={String(tier)}
                              >{`${tierLabel} ${tier}`}</SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <RoleProviderToggle
                          label={label}
                          value={provider}
                          onChange={(provider) =>
                            updateSettings({ modelRoles: { [name]: { [level]: { provider } } } })
                          }
                        />
                        <Select
                          value={effort}
                          onValueChange={(value) => {
                            const effort = ModelRoleEffort.literals.find(
                              (effort) => effort === value,
                            );
                            if (effort !== undefined)
                              updateSettings({ modelRoles: { [name]: { [level]: { effort } } } });
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            variant="ghost"
                            aria-label={`${label} · ${effortLabel}`}
                          >
                            <SelectValue>{effortLabels[effort]}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {ModelRoleEffort.literals.map((effort) => (
                              <SelectItem key={effort} value={effort}>
                                {effortLabels[effort]}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                      {role.targets.map((target) => {
                        const entry = entries.find(
                          (entry) => entry.instanceId === target.providerInstanceId,
                        );
                        const model = modelOptionsByInstance
                          .get(target.providerInstanceId)
                          ?.find(
                            (model) =>
                              model.slug === target.model || model.aliases?.includes(target.model),
                          );
                        const descriptors = entry?.models.find(
                          (model) =>
                            model.slug === target.model || model.aliases?.includes(target.model),
                        )?.capabilities?.optionDescriptors;
                        const effortAvailable =
                          effort === "default" ||
                          descriptors === undefined ||
                          descriptors.some(
                            (option) =>
                              option.type === "select" &&
                              option.id === target.options?.[0]?.id &&
                              option.options.some((choice) => choice.id === effort),
                          );
                        const available =
                          entry &&
                          isProviderInstancePickerReady(entry) &&
                          entry.snapshot.auth.status !== "unauthenticated" &&
                          model &&
                          !model.isUnavailable &&
                          effortAvailable;
                        return (
                          <span
                            key={target.providerInstanceId}
                            className={
                              available ? "text-xs text-muted-foreground" : "text-xs text-warning"
                            }
                          >
                            {target.model}
                            {available ? "" : ` · ${gt("Unavailable")}`}
                          </span>
                        );
                      })}
                    </div>
                  }
                />
              );
            })}
        </div>
      ))}
    </SettingsSection>
  );
}
