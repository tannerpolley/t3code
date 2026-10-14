import { type ModelSelection, UsageLimitRecoveryMode } from "@t3tools/contracts";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MODE_LABELS = { off: "Off", wait: "Wait for reset", switch: "Switch provider" };

export function UsageLimitRecoverySettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  ).filter((entry) => entry.driverKind === "codex" || entry.driverKind === "claudeAgent");
  const models = getCustomModelOptionsByInstance(settings, providers);
  const save = (selection: ModelSelection) =>
    update({
      usageLimitFallbackModels: [
        ...settings.usageLimitFallbackModels.filter(
          (saved) => saved.instanceId !== selection.instanceId,
        ),
        selection,
      ],
    });
  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("usage-limit-recovery")}
        settingKeys={["usageLimitRecovery"]}
        description="Choose what happens after a usage limit. Switching moves only the limited thread and continues without asking, including in Don't ask mode. If no alternative is available, it waits for reset."
        control={
          <Select
            value={settings.usageLimitRecovery}
            onValueChange={(value) => {
              if (value === "off" || value === "wait" || value === "switch")
                update({ usageLimitRecovery: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Usage limit recovery">
              <SelectValue>{MODE_LABELS[settings.usageLimitRecovery]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {UsageLimitRecoveryMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {settings.usageLimitRecovery === "switch"
        ? entries.map((entry) => {
            const saved = settings.usageLimitFallbackModels.find(
              (selection) => selection.instanceId === entry.instanceId,
            );
            return (
              <SettingsRow
                key={entry.instanceId}
                serverScoped
                settingKeys={["usageLimitFallbackModels"]}
                title={`${entry.displayName} fallback`}
                description="Model and effort used when a thread has no matching model role. Choose effort separately for each provider."
                control={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <ProviderModelPicker
                      environmentId={environment?.environmentId ?? null}
                      activeInstanceId={entry.instanceId}
                      model={saved?.model ?? ""}
                      lockedProvider={entry.driverKind}
                      instanceEntries={[entry]}
                      modelOptionsByInstance={models}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onInstanceModelChange={(instanceId, model) => save({ instanceId, model })}
                    />
                    {saved ? (
                      <>
                        <TraitsPicker
                          provider={entry.driverKind}
                          models={entry.models}
                          model={saved.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={saved.options ?? null}
                          allowPromptInjectedEffort={false}
                          planModeEnabled={settings.planModeEnabled}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          onModelOptionsChange={(options) =>
                            save({
                              instanceId: saved.instanceId,
                              model: saved.model,
                              ...(options === undefined ? {} : { options }),
                            })
                          }
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            update({
                              usageLimitFallbackModels: settings.usageLimitFallbackModels.filter(
                                (selection) => selection.instanceId !== entry.instanceId,
                              ),
                            })
                          }
                        >
                          Clear
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not configured</span>
                    )}
                  </div>
                }
              />
            );
          })
        : null}
    </>
  );
}
