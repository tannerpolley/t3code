import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { CommandPaletteContent } from "../CommandPaletteContent";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "../files/ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "../files/projectFilesQueryState";
import { CommandDialog, CommandDialogPopup } from "../ui/command";

export function ArtifactFilePickerDialog(props: {
  cwd: string;
  environmentId: EnvironmentId;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const result = useProjectFilePickerQuery(
    props.environmentId,
    props.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const items: CommandPaletteActionItem[] = getProjectFilePickerMatches(
    result.entries,
    result.matchedQuery,
  ).map((match) => ({
    icon: null,
    kind: "action",
    value: `artifact:${match.path}`,
    searchTerms: [match.name, match.path],
    title: match.name,
    description: match.path,
    run: async () => props.onSelect(match.path),
  }));
  return (
    <CommandDialog open onOpenChange={props.onOpenChange}>
      <CommandDialogPopup
        aria-label="Choose artifact file"
        className="overflow-hidden"
        onBackdropPointerDown={() => props.onOpenChange(false)}
      >
        <CommandPaletteContent
          aria-label="Choose artifact file"
          autoHighlight="always"
          escapeLabel="Close"
          footerActionLabel="Select file"
          inputProps={{ placeholder: "Search project files…" }}
          mode="none"
          onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
          onValueChange={(value) => {
            setHighlighted(null);
            setQuery(value);
          }}
          panelSize="tall-list"
          testId="artifact-file-picker"
          value={query}
        >
          <CommandPaletteResults
            groups={items.length ? [{ value: "files", label: "Project files", items }] : []}
            highlightedItemValue={highlighted}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action") return;
              props.onOpenChange(false);
              void item.run();
            }}
            emptyStateMessage={
              result.error ?? (result.isPending ? "Searching project files…" : "No matching files.")
            }
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
