import type { AgentSessionProjectCandidate, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  planCodexProjectSettingsImport,
  resolveOnboardingProjectId,
} from "../../onboarding/projectImport.logic";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Checkbox } from "../ui/checkbox";

type CodexSettingsCandidate = Pick<
  AgentSessionProjectCandidate,
  "path" | "projectId" | "codexSettings"
> & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

/**
 * Codex project settings offered while importing projects during onboarding
 * (the `onboardingCodexSettings` client setting): a preview for the selected
 * projects, and `apply`, which writes them once the user opts in.
 */
export function useCodexSettingsImport(selected: ReadonlyArray<CodexSettingsCandidate>) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const offered = useClientSettings((settings) => settings.onboardingCodexSettings);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [enabled, setEnabled] = useState(false);
  const readProjectOverrides = (environmentId: EnvironmentId, projectId: ProjectId | null) => {
    const settings = environments.find(
      (environment) => environment.environmentId === environmentId,
    )?.serverConfig?.settings;
    if (settings === undefined) return null;
    return projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  };
  const preview = selected.flatMap((candidate) => {
    if (!offered || candidate.codexSettings === undefined) return [];
    const projectId = resolveOnboardingProjectId(projects, candidate.environmentId, candidate);
    const plan = planCodexProjectSettingsImport(
      readProjectOverrides(candidate.environmentId, projectId) ?? undefined,
      candidate.codexSettings,
    );
    return [{ candidate, preview: candidate.codexSettings, plan }];
  });

  /** Writes one imported project's supported settings; false when they were not saved. */
  const apply = async (candidate: CodexSettingsCandidate, projectId: ProjectId) => {
    if (!enabled || candidate.codexSettings === undefined) return true;
    const current = readProjectOverrides(candidate.environmentId, projectId);
    if (current === null) return false;
    const plan = planCodexProjectSettingsImport(current, candidate.codexSettings);
    if (plan.action !== "write") return true;
    const result = await updateSettings({
      environmentId: candidate.environmentId,
      input: { patch: { projectSettingsOverrides: { [projectId]: plan.overrides } } },
    });
    return result._tag === "Success" || isAtomCommandInterrupted(result);
  };

  return { preview, enabled, setEnabled, apply };
}

export function CodexSettingsPreview({
  preview,
  checked,
  onCheckedChange,
  disabled,
}: {
  readonly preview: ReturnType<typeof useCodexSettingsImport>["preview"];
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) {
  if (preview.length === 0) return null;
  return (
    <div className="mt-3 space-y-2 rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
      <div>
        <p className="font-medium text-foreground">Codex settings preview — no changes yet</p>
        <p className="mt-1 text-muted-foreground">
          Codex <code>trusted</code> maps to T3 <strong>Auto-accept edits</strong>;{" "}
          <code>untrusted</code> maps to <strong>Approval required</strong>.
        </p>
      </div>
      <ul className="space-y-1 text-muted-foreground">
        {preview.map(({ candidate, preview: settings, plan }) => (
          <li key={candidate.key} className="break-words">
            <span className="font-mono">{candidate.path}</span>:{" "}
            {settings.trustLevel ?? "no supported trust value"}
            {plan.action === "conflict" ? "; existing T3 runtime mode will be kept" : ""}
            {settings.unsupportedKeys.length > 0
              ? `; unsupported: ${settings.unsupportedKeys.join(", ")}`
              : ""}
          </li>
        ))}
      </ul>
      <label className="flex cursor-pointer items-center gap-2 text-foreground">
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(next === true)}
          disabled={disabled}
        />
        Apply supported Codex settings when importing
      </label>
    </div>
  );
}
