import { sidebarColumnBudget, sidebarColumnLayout } from "./SidebarColumns.layout";
import "./ForkSidebarDebug.css";
import { observeResize } from "../../lib/observeResize";

export const SIDEBAR_DEBUG_OPTIONS = [
  { key: "columns", title: "Outline sidebar columns" },
  { key: "width", title: "Show sidebar width" },
  { key: "separators", title: "Label separator lines" },
] as const;
type DebugOption = (typeof SIDEBAR_DEBUG_OPTIONS)[number]["key"];
const storageKey = (key: DebugOption) => `t3code:debug-sidebar-${key}`;
const listeners = new Set<() => void>();
const enabled = new Set<DebugOption>();
let stopWidth: (() => void) | undefined;

export function sidebarDebugEnabled(key: DebugOption) {
  return enabled.has(key);
}

export function subscribeSidebarDebug(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSidebarDebug(key: DebugOption, value: boolean) {
  if (value) enabled.add(key);
  else enabled.delete(key);
  try {
    localStorage.setItem(storageKey(key), value ? "1" : "0");
  } catch {
    /* Storage may be disabled. */
  }
  applyDebug();
  for (const listener of listeners) listener();
}

function showWidth() {
  const label = document.createElement("output");
  label.className = "fork-sidebar-debug-width";
  label.dataset.sidebarDebug = "";
  const measure = document.createElement("span");
  measure.dataset.sidebarDebug = "";
  measure.className = "fork-sidebar-debug-measure";
  document.body.append(label, measure);
  const observed = new Map<Element, () => void>();
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const update = () => {
    frame = 0;
    const sidebar = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"], [data-sidebar="sidebar"]',
    );
    const containers = [
      ...document.querySelectorAll<HTMLElement>(".sidebar-columns-container"),
    ].filter((element) => element.getBoundingClientRect().width > 0);
    const targets = new Set<Element>([
      document.documentElement,
      ...containers,
      ...(sidebar ? [sidebar] : []),
    ]);
    for (const [element, stop] of observed)
      if (!targets.has(element)) {
        stop();
        observed.delete(element);
      }
    for (const element of targets)
      if (!observed.has(element)) {
        observed.set(element, observeResize(element, schedule));
      }
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const width = sidebar?.getBoundingClientRect().width;
    const lines = [
      width === undefined
        ? "Sidebar unavailable"
        : `Sidebar ${width.toFixed(0)}px / ${(width / rem).toFixed(2)}rem`,
    ];
    // Projects can use different container fonts; report each distinct set of boundaries.
    const budgets = new Set<string>();
    for (const container of containers) {
      measure.style.font = getComputedStyle(container).font;
      const ch = measure.getBoundingClientRect().width;
      const roleDisplay =
        container.querySelector<HTMLElement>("[data-sidebar-role-display]")?.dataset
          .sidebarRoleDisplay === "icon"
          ? "icon"
          : "name";
      const hidden = new Set<string>();
      const thresholds = sidebarColumnLayout.dropOrder.map((group) => {
        const budget = sidebarColumnBudget(hidden, roleDisplay);
        const boundary = budget.rem * rem + budget.px + budget.ch * ch;
        group.forEach((column) => hidden.add(column));
        return `${group.join("+")} < ${boundary.toFixed(0)}px / ${(boundary / rem).toFixed(2)}rem`;
      });
      budgets.add(
        `Rows ${container.getBoundingClientRect().width.toFixed(0)}px (${roleDisplay}): ${thresholds.join("; ")}`,
      );
    }
    lines.push(...budgets);
    if (containers.length === 0) lines.push("Expand a project to see column drop widths");
    const text = lines.join("\n");
    if (label.textContent !== text) label.textContent = text;
  };
  const mutations = new MutationObserver((records) => {
    const isDebug = (node: Node) =>
      node instanceof Element && node.closest("[data-sidebar-debug]") !== null;
    if (
      records.some(
        (record) =>
          !isDebug(record.target) &&
          (record.type !== "childList" ||
            [...record.addedNodes, ...record.removedNodes].some((node) => !isDebug(node))),
      )
    )
      schedule();
  });
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-sidebar-role-display"],
  });
  document.fonts.addEventListener("loadingdone", schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    for (const stop of observed.values()) stop();
    mutations.disconnect();
    document.fonts.removeEventListener("loadingdone", schedule);
    label.remove();
    measure.remove();
  };
}

function applyDebug() {
  document.documentElement.toggleAttribute("data-debug-sidebar-columns", enabled.has("columns"));
  document.documentElement.toggleAttribute(
    "data-debug-sidebar-separators",
    enabled.has("separators"),
  );
  if (enabled.has("width")) stopWidth ??= showWidth();
  else {
    stopWidth?.();
    stopWidth = undefined;
  }
}

for (const { key } of SIDEBAR_DEBUG_OPTIONS) {
  try {
    if (localStorage.getItem(storageKey(key)) === "1") enabled.add(key);
  } catch {
    /* Storage may be disabled. */
  }
}
applyDebug();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopWidth?.();
  });
