import { ListFilterIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  changedIssueFilterCount,
  DEFAULT_ISSUE_FILTER_PREFERENCES,
  IssueFilterPreferences,
} from "./issueWorkspace.logic";

/** The Filter menu's saved choices, shared by the Issues page and the thread's issue list. */
export function useIssueFilterPreferences() {
  return useLocalStorage(
    "t3code:issues-filters",
    DEFAULT_ISSUE_FILTER_PREFERENCES,
    IssueFilterPreferences,
  );
}

type ShowKey = {
  [Key in keyof IssueFilterPreferences]: IssueFilterPreferences[Key] extends boolean ? Key : never;
}[keyof IssueFilterPreferences];

const ISSUE_OPTIONS: ReadonlyArray<readonly [ShowKey, string]> = [
  ["open", "Open"],
  ["closed", "Closed"],
];
const REPOSITORY_OPTIONS: ReadonlyArray<readonly [ShowKey, string]> = [
  ["archived", "Archived"],
  ["forks", "Forks"],
  ["empty", "Empty"],
  ["public", "Public"],
  ["private", "Private"],
  ["personal", "Personal"],
  ["organizations", "Organizations"],
];

function RadioSection<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<readonly [Value, string]>;
  onChange: (value: Value) => void;
}) {
  return (
    <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map(([option, optionLabel]) => (
        <MenuRadioItem key={option} value={option}>
          <span className="flex items-center gap-2">
            <span className="flex-1">{optionLabel}</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/**
 * Every list narrowing behind one control: positive "show" checkboxes for issue states and
 * repository kinds, then milestone, assignment, host and sort. The trigger counts choices that
 * differ from the defaults. A single repository's list drops the repository choices and uses an
 * icon trigger.
 */
export function IssueFilterMenu({
  preferences,
  onChange,
  hosts,
  host,
  onHostChange,
  singleRepository = false,
}: {
  preferences: IssueFilterPreferences;
  onChange: (preferences: IssueFilterPreferences) => void;
  /** Host choices appear only when repositories span more than one host. */
  hosts: ReadonlyArray<string>;
  host: string;
  onHostChange: (host: string) => void;
  singleRepository?: boolean;
}) {
  const changed = singleRepository
    ? (["open", "closed", "milestone", "assignee"] as const).filter(
        (key) => preferences[key] !== DEFAULT_ISSUE_FILTER_PREFERENCES[key],
      ).length
    : changedIssueFilterCount(preferences) + (host === "" ? 0 : 1);
  const checkbox = ([key, label]: readonly [ShowKey, string]) => (
    <MenuCheckboxItem
      key={key}
      checked={preferences[key]}
      onCheckedChange={(checked) => onChange({ ...preferences, [key]: checked })}
    >
      {label}
    </MenuCheckboxItem>
  );
  return (
    <Menu>
      {singleRepository ? (
        <MenuTrigger
          aria-label="Filter issues"
          render={<Button size="icon-xs" variant="ghost" />}
          className={changed > 0 ? "text-foreground" : "text-muted-foreground/70"}
        >
          <ListFilterIcon aria-hidden className="size-3.5" />
        </MenuTrigger>
      ) : (
        <MenuTrigger render={<Button size="sm" variant="outline" />}>
          <ListFilterIcon aria-hidden className="size-3.5" />
          <span>Filter</span>
          {changed > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
              {changed}
            </span>
          ) : null}
        </MenuTrigger>
      )}
      <MenuPopup align="end" side="bottom" className="max-h-[70vh] w-52 overflow-y-auto">
        <MenuGroup>
          <MenuGroupLabel>Show issues</MenuGroupLabel>
          {ISSUE_OPTIONS.map(checkbox)}
        </MenuGroup>
        {singleRepository ? null : (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Show repositories</MenuGroupLabel>
              {REPOSITORY_OPTIONS.map(checkbox)}
            </MenuGroup>
          </>
        )}
        <MenuSeparator />
        <RadioSection
          label="Milestone"
          value={preferences.milestone}
          options={[
            ["all", "All milestones"],
            ["with", "With milestone"],
            ["without", "No milestone"],
          ]}
          onChange={(milestone) => onChange({ ...preferences, milestone })}
        />
        <MenuSeparator />
        <RadioSection
          label="Assignment"
          value={preferences.assignee}
          options={[
            ["all", "Everyone"],
            ["assigned", "Assigned"],
            ["unassigned", "Unassigned"],
          ]}
          onChange={(assignee) => onChange({ ...preferences, assignee })}
        />
        {hosts.length > 1 ? (
          <>
            <MenuSeparator />
            <RadioSection
              label="Host"
              value={host}
              options={[["", "All hosts"], ...hosts.map((entry) => [entry, entry] as const)]}
              onChange={onHostChange}
            />
          </>
        ) : null}
        <MenuSeparator />
        <RadioSection
          label="Sort issues"
          value={preferences.sort}
          options={[
            ["updated", "Recently updated"],
            ["oldest", "Oldest updated"],
            ["number", "Issue number"],
            ["title", "Title"],
          ]}
          onChange={(sort) => onChange({ ...preferences, sort })}
        />
      </MenuPopup>
    </Menu>
  );
}
