import type { ProjectTask, ProjectTaskKind } from "@t3tools/client-runtime/state/project-tasks";
import { MonitorIcon, TerminalIcon, WorkflowIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { SidebarCollapsibleSection } from "./SidebarCollapsibleSection";

const sections: readonly { kind: ProjectTaskKind; label: string }[] = [
  { kind: "commands", label: msg("Commands", { $context: "project tasks subsection" }) },
  { kind: "monitors", label: msg("Monitors", { $context: "project tasks subsection" }) },
  { kind: "terminals", label: msg("Terminals", { $context: "project tasks subsection" }) },
  { kind: "workflows", label: msg("Workflows", { $context: "project tasks subsection" }) },
];

export function SidebarProjectTasks(props: {
  readonly id: string;
  readonly parent: string;
  readonly depth: number;
  readonly tasks: readonly ProjectTask[];
  readonly now: number;
  readonly collapsed: boolean;
  readonly onToggle: (id: string, all: boolean) => void;
  readonly onOpen: (task: ProjectTask) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  if (props.tasks.length === 0) return null;
  const inset = `calc(var(--sidebar-row-content-inset) + 16px + ${Math.min(props.depth, 3) * 10}px)`;
  return (
    <li className="list-none">
      <SidebarCollapsibleSection
        id={props.id}
        parent={props.parent}
        depth={props.depth}
        collapsed={props.collapsed}
        onToggle={props.onToggle}
        label={gt("Tasks", { $context: "project sidebar section" })}
      >
        <span className="tabular-nums">
          · {gt("{count} running", { count: props.tasks.length })}
        </span>
      </SidebarCollapsibleSection>
      {!props.collapsed &&
        sections.map((section) => {
          const tasks = props.tasks.filter((task) => task.kind === section.kind);
          if (tasks.length === 0) return null;
          const Icon =
            section.kind === "monitors"
              ? MonitorIcon
              : section.kind === "workflows"
                ? WorkflowIcon
                : TerminalIcon;
          return (
            <div key={section.kind}>
              <div
                className="py-1 text-xs font-medium text-sidebar-muted-foreground"
                style={{ paddingInlineStart: inset }}
              >
                {messages(section.label)}
              </div>
              {tasks.map((task) => (
                <button
                  key={`${task.thread.environmentId}:${task.thread.id}:${task.id}`}
                  type="button"
                  data-sidebar-parent={props.id}
                  onClick={() => props.onOpen(task)}
                  style={{ paddingInlineStart: inset }}
                  className="flex w-full items-center gap-2 rounded-(--control-radius) py-1 pe-2 text-left text-xs hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <Icon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{task.description}</span>
                  <span className="max-w-20 truncate text-sidebar-muted-foreground">
                    {task.thread.title}
                  </span>
                  {task.startedAt && (
                    <time
                      className="shrink-0 tabular-nums text-sidebar-muted-foreground"
                      dateTime={task.startedAt}
                    >
                      {Math.max(0, Math.floor((props.now - Date.parse(task.startedAt)) / 60000))}m
                    </time>
                  )}
                </button>
              ))}
            </div>
          );
        })}
    </li>
  );
}
