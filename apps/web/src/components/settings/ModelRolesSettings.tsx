import {
  DEFAULT_MODEL_ROLES,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLE_NAME_LENGTH,
  MAX_MODEL_ROLES,
  type ModelRole,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
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
  const serverRoles = settings.modelRoles;
  // Handlers read the ref so two actions in one tick (a name committed on
  // blur, then a click) both build on the latest list.
  const [draft, setDraft] = useState(() => modelRolesDraft(serverRoles));
  const draftRef = useRef(draft);
  useEffect(() => {
    const next = receiveServerModelRoles(draftRef.current, serverRoles);
    draftRef.current = next;
    setDraft(next);
  }, [serverRoles]);
  const edit = (change: ModelRoleEdit) => {
    const next = editModelRolesDraft(draftRef.current, change);
    if (next === draftRef.current) return;
    draftRef.current = next;
    setDraft(next);
    updateSettings({ modelRoles: next.roles });
  };
  const roles = draft.roles;
  const unavailableReason = (role: ModelRole): string | null => {
    const entry = entries.find(
      (candidate) => candidate.instanceId === role.target.providerInstanceId,
    );
    if (!entry?.enabled) {
      return `Provider ${role.target.providerInstanceId} isn't enabled on this environment.`;
    }
    if (!entry.installed) return `${entry.displayName} isn't installed.`;
    if (entry.snapshot.auth.status === "unauthenticated") {
      return `${entry.displayName} isn't signed in.`;
    }
    if (!isProviderInstancePickerReady(entry)) {
      return entry.snapshot.message ?? `${entry.displayName} isn't ready.`;
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
        description="Defaults orchestrating agents see for delegated work: which model and effort suits each kind of task. Agents choose among them at their discretion, and your explicit instructions win. Codex: next turn. Claude: next session. Agents can re-read them anytime via orchestrator_capabilities."
        resetAction={
          Equal.equals(roles, DEFAULT_MODEL_ROLES) ? null : (
            <SettingResetButton
              label="model roles"
              onClick={() => edit({ type: "replace", roles: DEFAULT_MODEL_ROLES })}
            />
          )
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={roles.length >= MAX_MODEL_ROLES}
            onClick={() =>
              edit({
                type: "add",
                role: {
                  id: `role-${randomUUID().slice(0, 8)}`,
                  name: "New role",
                  description: "",
                  target: (draftRef.current.roles[0] ?? DEFAULT_MODEL_ROLES[0]!).target,
                },
              })
            }
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
                maxLength={MAX_MODEL_ROLE_NAME_LENGTH}
                value={role.name}
                onCommit={(next) => {
                  const name = next.trim();
                  if (name.length > 0 && name !== role.name) {
                    edit({ type: "update", id: role.id, patch: { name } });
                  }
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
                  if (description !== role.description) {
                    edit({ type: "update", id: role.id, patch: { description } });
                  }
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
                    edit({
                      type: "update",
                      id: role.id,
                      patch: { target: { providerInstanceId, model } },
                    })
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
                      edit({ type: "options", id: role.id, options })
                    }
                  />
                ) : null}
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
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${role.name}`}
                  onClick={() => edit({ type: "remove", id: role.id })}
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
