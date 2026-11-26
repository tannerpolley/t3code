import { createStore } from "zustand";

export const sidebarFamilyExpansion = createStore<ReadonlyMap<string, boolean>>(() => new Map());

export function setSidebarFamilyExpanded(key: string, expanded: boolean) {
  sidebarFamilyExpansion.setState((current) => new Map(current).set(key, expanded), true);
}
