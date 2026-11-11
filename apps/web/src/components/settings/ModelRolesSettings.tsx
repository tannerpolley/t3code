import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentProviders } from "../../state/environments";
import { ForkSettingsRow as SettingsRow } from "./ForkSettingsRow";
import {
  DEFAULT_MODEL_ROLES,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLE_TARGETS,
  type ModelRoleTarget,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { WorkerProviderSelect } from "../WorkerProviderSelect";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  editModelRolesDraft,
  type ModelRoleEdit,
  modelRolesDraft,
  receiveServerModelRoles,
} from "./modelRolesDraft";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
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
  const providers =
    useEnvironmentProviders().get(environment?.environmentId as EnvironmentId) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const serverRoles = settings.modelRoles;
  // Handlers read the ref so two actions in one tick (a name committed on
  // blur, then a click) both build on the latest list.
  const [draft, setDraft] = useState(() => modelRolesDraft(serverRoles));
  const draftRef = useRef(draft);
  const received = receiveServerModelRoles(draft, serverRoles);
  if (received !== draft) setDraft(received);
  const edit = (change: ModelRoleEdit) => {
    const next = editModelRolesDraft(
      receiveServerModelRoles(draftRef.current, serverRoles),
      change,
    );
    if (next === draftRef.current) return;
    draftRef.current = next;
    setDraft(next);
    updateSettings({ modelRoles: next.roles });
  };
  const roles = received.roles;
  const unavailableReason = (target: ModelRoleTarget): string | null => {
    const entry = entries.find((candidate) => candidate.instanceId === target.providerInstanceId);
    if (!entry?.enabled) {
      return `Provider ${target.providerInstanceId} isn't enabled on this environment.`;
    }
    if (!entry.installed) return `${entry.displayName} isn't installed.`;
    if (entry.snapshot.auth.status === "unauthenticated") {
      return `${entry.displayName} isn't signed in.`;
    }
    if (!isProviderInstancePickerReady(entry)) {
      return entry.snapshot.message ?? `${entry.displayName} isn't ready.`;
    }
    const models = modelOptionsByInstance.get(entry.instanceId) ?? [];
    return models.some((option) => option.slug === target.model && !option.isUnavailable)
      ? null
      : `${entry.displayName} doesn't offer ${target.model} right now.`;
  };

  return (
    <SettingsSection title="Model roles">
      <SettingsRow
        serverScoped
        settingKeys={["workerProvider"]}
        {...searchableSetting("worker-provider")}
        description="Prefer Claude, Codex, or weekly usage ordering for worker roles. Orchestrators are unchanged; roles without an available choice from the chosen provider keep their choices."
        control={
          <WorkerProviderSelect
            value={settings.workerProvider}
            onChange={(workerProvider) => updateSettings({ workerProvider })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={MODEL_ROLE_KEYS}
        {...searchableSetting("model-roles")}
        description="Delegation defaults in choice order; agents may choose alternatives and follow your instructions. Codex reads changes next turn; Claude next session. Agents can re-read roles anytime."
        resetAction={
          Equal.equals(roles, DEFAULT_MODEL_ROLES) ? null : (
            <SettingResetButton
              label="model roles"
              onClick={() => edit({ type: "replace", roles: DEFAULT_MODEL_ROLES })}
            />
          )
        }
      />
      {roles.map((role, index) => {
        return (
          <SettingsRow
            key={role.id}
            serverScoped
            settingKeys={MODEL_ROLE_KEYS}
            title={role.name}
            description={
              <DraftInput
                aria-label={`When to use ${role.name}`}
                size="sm"
                maxLength={MAX_MODEL_ROLE_DESCRIPTION_LENGTH}
                placeholder="When to use this role"
                value={role.description}
                onCommit={(next) => {
                  const description = next.trim();
                  if (description !== role.description) {
                    edit({ type: "update", id: role.id, patch: { description } });
                  }
                }}
              />
            }
            control={
              <div className="flex flex-col items-end gap-2">
                {role.targets.map((target, targetIndex) => {
                  const entry = entries.find(
                    (candidate) => candidate.instanceId === target.providerInstanceId,
                  );
                  const reason = unavailableReason(target);
                  return (
                    // oxlint-disable-next-line react/no-array-index-key -- Choices are ordered editable slots and may contain identical configurations.
                    <div key={targetIndex} className="flex flex-col items-end gap-1">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={targetIndex === 0}
                          aria-label={`Make choice ${targetIndex + 1} the default for ${role.name}`}
                          onClick={() =>
                            edit({ type: "target-default", id: role.id, index: targetIndex })
                          }
                        >
                          {targetIndex === 0 ? "Default" : "Make default"}
                        </Button>
                        <ProviderModelPicker
                          environmentId={environment?.environmentId ?? null}
                          activeInstanceId={target.providerInstanceId}
                          model={target.model}
                          lockedProvider={null}
                          instanceEntries={entries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          onInstanceModelChange={(providerInstanceId, model) =>
                            edit({
                              type: "target-update",
                              id: role.id,
                              index: targetIndex,
                              target: { providerInstanceId, model },
                            })
                          }
                        />
                        {entry ? (
                          <TraitsPicker
                            provider={entry.driverKind}
                            models={entry.models}
                            model={target.model}
                            modelOptions={target.options ?? null}
                            allowPromptInjectedEffort={false}
                            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                            onModelOptionsChange={(options) =>
                              edit({ type: "options", id: role.id, index: targetIndex, options })
                            }
                          />
                        ) : null}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove choice ${targetIndex + 1} from ${role.name}`}
                          disabled={role.targets.length === 1}
                          onClick={() =>
                            edit({ type: "target-remove", id: role.id, index: targetIndex })
                          }
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                      {reason ? <span className="text-xs text-warning">{reason}</span> : null}
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {role.role === undefined ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => edit({ type: "remove", id: role.id })}
                    >
                      <Trash2Icon className="size-3.5" />
                      Remove role
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={role.targets.length >= MAX_MODEL_ROLE_TARGETS}
                    onClick={() =>
                      edit({
                        type: "target-add",
                        id: role.id,
                        target: draftRef.current.roles.find(
                          (candidate) => candidate.id === role.id,
                        )!.targets[0],
                      })
                    }
                  >
                    <PlusIcon className="size-3.5" />
                    Add choice
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move ${role.name} up`}
                    disabled={index === 0}
                    onClick={() => edit({ type: "move", id: role.id, offset: -1 })}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move ${role.name} down`}
                    disabled={index === roles.length - 1}
                    onClick={() => edit({ type: "move", id: role.id, offset: 1 })}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
