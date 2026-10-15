import { ForkSettingsRow as SettingsRow } from "./ForkSettingsRow";
import { PROJECT_LOCAL_WORKTREES } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODE_LABELS = {
  home: "T3 home (default)",
  custom: "One custom folder",
  project: "Inside each project",
};

export function WorktreesDirectoryRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreesDirectory"]);
  const edited = useRef(false);
  const scopeKey = `${targets.map((target) => target.environmentId).join(",")}:${mixed}:${settings.worktreesDirectory}`;
  // Choosing Custom shows an empty editor until a folder is entered.
  const [customFor, setCustomFor] = useState<string | null>(null);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreesDirectory !== true,
    )
  )
    return null;
  const projectLocalSupported = connectedEnvironments.every(
    (environment) =>
      environment.serverConfig?.environment.capabilities.projectLocalWorktrees === true,
  );
  const mode =
    customFor === scopeKey
      ? "custom"
      : settings.worktreesDirectory === PROJECT_LOCAL_WORKTREES
        ? "project"
        : settings.worktreesDirectory === ""
          ? "home"
          : "custom";
  const reset = () => {
    setCustomFor(null);
    updateSettings({ worktreesDirectory: "" });
  };
  return (
    <SettingsRow
      {...searchableSetting("storage-worktrees-location")}
      description="Choose where new worktrees are created; existing worktrees stay where they are. Inside each project uses .worktrees at the Git repository's top level, even when the project is a subfolder."
      serverScoped
      settingKeys={["worktreesDirectory"]}
      resetAction={
        mixed || settings.worktreesDirectory !== "" || customFor === scopeKey ? (
          <SettingResetButton label="worktree location" onClick={reset} />
        ) : null
      }
      control={
        <div className="flex flex-col gap-2">
          <Select
            value={mixed && customFor !== scopeKey ? null : mode}
            onValueChange={(value) => {
              edited.current = false;
              if (value === "custom") setCustomFor(scopeKey);
              else if (value === "home" || value === "project") {
                setCustomFor(null);
                updateSettings({
                  worktreesDirectory: value === "project" ? PROJECT_LOCAL_WORKTREES : "",
                });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Worktree location">
              <SelectValue>
                {mixed && customFor !== scopeKey ? "Mixed" : MODE_LABELS[mode]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="home">{MODE_LABELS.home}</SelectItem>
              <SelectItem value="custom">{MODE_LABELS.custom}</SelectItem>
              <SelectItem value="project" disabled={!projectLocalSupported}>
                {MODE_LABELS.project}
              </SelectItem>
            </SelectPopup>
          </Select>
          {mode === "custom" && (!mixed || customFor === scopeKey) ? (
            <Input
              key={scopeKey}
              aria-label="Custom worktree folder"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Absolute folder, e.g. ~/worktrees"
              defaultValue={
                mixed || settings.worktreesDirectory === PROJECT_LOCAL_WORKTREES
                  ? ""
                  : settings.worktreesDirectory
              }
              onChange={() => {
                edited.current = true;
              }}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (edited.current && (mixed || value !== settings.worktreesDirectory))
                  updateSettings({ worktreesDirectory: value });
                edited.current = false;
              }}
            />
          ) : null}
        </div>
      }
    />
  );
}
