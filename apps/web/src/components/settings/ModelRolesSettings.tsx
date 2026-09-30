import {
  DEFAULT_MODEL_ROLES,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLES,
  type ModelRole,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { randomUUID } from "../../lib/utils";
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
import { DraftInput } from "../ui/draft-input";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MODEL_ROLE_KEYS = ["modelRoles"] as const;

/** Roles orchestrating agents read as delegation defaults; see `ModelRole` in contracts. */
export function ModelRolesSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const roles = settings.modelRoles;
  const save = (next: ReadonlyArray<ModelRole>) => updateSettings({ modelRoles: next });
  const updateRole = (index: number, patch: Partial<ModelRole>) =>
    save(roles.map((role, current) => (current === index ? { ...role, ...patch } : role)));
  const move = (index: number, offset: -1 | 1) => {
    const next = [...roles];
    const [role] = next.splice(index, 1);
    next.splice(index + offset, 0, role!);
    save(next);
  };
  const addRole = () =>
    save([
      ...roles,
      {
        id: `role-${randomUUID().slice(0, 8)}`,
        name: "New role",
        description: "",
        target: (roles[0] ?? DEFAULT_MODEL_ROLES[0]!).target,
      },
    ]);
  const unavailableReason = (role: ModelRole): string | null => {
    const entry = entries.find(
      (candidate) => candidate.instanceId === role.target.providerInstanceId,
    );
    if (!entry?.enabled || !entry.isAvailable) {
      return `Provider ${role.target.providerInstanceId} isn't available on this environment.`;
    }
    const models = modelOptionsByInstance.get(entry.instanceId) ?? [];
    return models.some((option) => option.slug === role.target.model && !option.isUnavailable)
      ? null
      : `${entry.displayName} doesn't offer ${role.target.model} right now.`;
  };

  return (
    <SettingsSection title="Model roles">
      <SettingsRow
        serverScoped
        settingKeys={MODEL_ROLE_KEYS}
        {...searchableSetting("model-roles")}
        description="Defaults orchestrating agents see for delegated work: which model and effort suits each kind of task. Agents choose among them at their discretion, and your explicit instructions win. Changes apply to new sessions and turns; running agents can re-read them with orchestrator_capabilities."
        resetAction={
          Equal.equals(roles, DEFAULT_MODEL_ROLES) ? null : (
            <SettingResetButton label="model roles" onClick={() => save(DEFAULT_MODEL_ROLES)} />
          )
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={roles.length >= MAX_MODEL_ROLES}
            onClick={addRole}
          >
            <PlusIcon className="size-3.5" />
            Add role
          </Button>
        }
      />
      {roles.map((role, index) => {
        const entry = entries.find(
          (candidate) => candidate.instanceId === role.target.providerInstanceId,
        );
        const reason = unavailableReason(role);
        return (
          <SettingsRow
            key={role.id}
            serverScoped
            settingKeys={MODEL_ROLE_KEYS}
            title={
              <DraftInput
                aria-label="Role name"
                size="sm"
                maxLength={60}
                value={role.name}
                onCommit={(next) => {
                  const name = next.trim();
                  if (name.length > 0 && name !== role.name) updateRole(index, { name });
                }}
              />
            }
            description={
              <DraftInput
                aria-label={`When to use ${role.name}`}
                size="sm"
                maxLength={MAX_MODEL_ROLE_DESCRIPTION_LENGTH}
                placeholder="When to use this role"
                value={role.description}
                onCommit={(next) => {
                  const description = next.trim();
                  if (description !== role.description) updateRole(index, { description });
                }}
              />
            }
            status={reason ? <span className="text-warning">{reason}</span> : null}
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={role.target.providerInstanceId}
                  model={role.target.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(providerInstanceId, model) =>
                    updateRole(index, { target: { providerInstanceId, model } })
                  }
                />
                {entry ? (
                  <TraitsPicker
                    provider={entry.driverKind}
                    models={entry.models}
                    model={role.target.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={role.target.options ?? null}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateRole(index, {
                        target: {
                          providerInstanceId: role.target.providerInstanceId,
                          model: role.target.model,
                          ...(options === undefined ? {} : { options }),
                        },
                      })
                    }
                  />
                ) : null}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${role.name} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${role.name} down`}
                  disabled={index === roles.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${role.name}`}
                  onClick={() => save(roles.filter((_, current) => current !== index))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
