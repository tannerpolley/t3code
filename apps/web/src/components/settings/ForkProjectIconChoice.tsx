import { msg, T } from "gt-react";
import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { MessageResolver } from "~/i18n/messages";
import { PROJECT_ICON_COLORS, projectIconColorClassName } from "../../projectIconOptions";
import { Toggle } from "../ui/toggle-group";
import { ForkSettingsTag } from "./ForkSettingsRow";

export const isProjectIconMode = (
  value: string | undefined,
): value is ProjectIconOverride["kind"] =>
  value === "lucide" || value === "emoji" || value === "monogram" || value === "folder";

export function forkProjectIconSelection(
  mode: ProjectIconOverride["kind"],
  color: ProjectIconColor,
): ProjectIconOverride | undefined {
  return mode === "folder" ? { kind: "folder", color } : undefined;
}

export function ForkProjectIconToggle() {
  return (
    <Toggle value="folder">
      <span className="inline-flex items-center gap-2">
        <T>Folder</T>
        <ForkSettingsTag />
      </span>
    </Toggle>
  );
}

export function ForkProjectFolderPreview({ color }: { readonly color: ProjectIconColor }) {
  return (
    <div className="flex items-center gap-4 py-2">
      <FolderIcon className={cn("size-12", projectIconColorClassName(color))} />
      <p className="flex-1 text-sm text-muted-foreground">
        <T>The sidebar's folder icon opens while the project is expanded.</T>
      </p>
    </div>
  );
}

export function forkProjectIconDescription(
  icon: ProjectIconOverride | null,
  resolve: MessageResolver,
) {
  if (icon?.kind !== "folder") return undefined;
  const color = PROJECT_ICON_COLORS.find((option) => option.value === icon.color);
  return resolve(msg("Folder · {color}", { color: color ? resolve(color.label) : icon.color }));
}
