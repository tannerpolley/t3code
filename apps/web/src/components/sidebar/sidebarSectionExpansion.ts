import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";

const key = "t3code:sidebar:agent-task-sections";
const schema = Schema.Struct({
  allExpanded: Schema.NullOr(Schema.Boolean),
  overrides: Schema.Record(Schema.String, Schema.Boolean),
});
type SectionExpansion = typeof schema.Type;
const allSections = (allExpanded: boolean | null): SectionExpansion => ({
  allExpanded,
  overrides: {},
});
const initial = allSections(null);
const legacySchema = Schema.Array(Schema.String);
const emptyKeys: readonly string[] = [];

export const collapseSidebarSectionsLabel = msg("Collapse all agent and task sections");
export const expandSidebarSectionsLabel = msg("Expand all agent and task sections");

export function setAllSidebarSectionsExpanded(expanded: boolean) {
  writeLocalStorageValue(key, allSections(expanded), initial, schema);
}

export function useSidebarSectionExpansion() {
  const [state, setState] = useLocalStorage(key, initial, schema);
  const [collapsedRoles] = useLocalStorage(
    "t3code:sidebar:role-sections-collapsed",
    emptyKeys,
    legacySchema,
  );
  const [expandedTasks] = useLocalStorage(
    "t3code:sidebar:task-sections-expanded",
    emptyKeys,
    legacySchema,
  );

  function defaultExpanded(id: string) {
    if (id.startsWith("tasks:")) return expandedTasks.includes(id.slice("tasks:".length));
    return !collapsedRoles.includes(id);
  }

  function isExpanded(current: SectionExpansion, id: string) {
    return current.overrides[id] ?? current.allExpanded ?? defaultExpanded(id);
  }

  function toggleSection(id: string, all: boolean) {
    setState((current) => {
      const expanded = !isExpanded(current, id);
      return all
        ? allSections(expanded)
        : { ...current, overrides: { ...current.overrides, [id]: expanded } };
    });
  }

  return { sectionExpanded: (id: string) => isExpanded(state, id), toggleSection };
}
