import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import type { ThreadProcessGroup, ThreadProcessMember } from "@t3tools/contracts";
import { CpuIcon } from "lucide-react";
import type { CSSProperties, ReactElement } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { ProcessProgramIcon } from "../ProcessProgramIcon";
import { ThreadStatusMark } from "../ThreadStatusMark";
import { AgentElapsed } from "../chat/AgentElapsed";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarCaretSlot, SidebarThreadColumns } from "./SidebarColumns";

function ProcessDetails(props: {
  readonly member: ThreadProcessMember;
  readonly children: ReactElement;
}) {
  const { member } = props;
  return (
    <Popover>
      <PopoverTrigger render={props.children} />
      <PopoverPopup side="right" align="start" width="lg">
        <div className="space-y-3 text-xs">
          <PopoverTitle>Process {member.pid}</PopoverTitle>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
            {member.commandLine}
          </pre>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt>PID</dt>
            <dd>{member.pid}</dd>
            <dt>Started</dt>
            <dd>
              <time dateTime={member.startedAt}>{new Date(member.startedAt).toLocaleString()}</time>
            </dd>
            <dt>CPU</dt>
            <dd>{member.cpuPercent.toFixed(1)}%</dd>
            <dt>Memory</dt>
            <dd>{formatBytes(member.residentBytes)}</dd>
          </dl>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SidebarThreadProcessesGroup(props: {
  readonly group: ThreadProcessGroup;
  readonly expansionKey: string;
  readonly columns: boolean;
  readonly className: string;
  readonly style: CSSProperties | undefined;
}) {
  const { group } = props;
  const key = `processes:${props.expansionKey}:group:${group.label}`;
  const open = useUiStateStore((state) => state.lineageDetailsExpandedById[key] === true);
  const setExpanded = useUiStateStore((state) => state.setLineageDetailsExpanded);
  const members = group.members ?? [];
  const expandable = group.count > 1 && members.length > 0;
  const iconClassName = props.columns ? "size-4" : "size-3.5";
  const icon = (
    <ProcessProgramIcon
      program={group.label}
      className={iconClassName}
      fallback={<CpuIcon aria-hidden className={iconClassName} />}
    />
  );
  const rowContent = (
    name: ReactElement,
    startedAt: string | undefined,
    caret?: ReactElement,
    count?: number,
  ) => {
    const time = startedAt ? (
      <AgentElapsed agent={{ status: "running", startedAt, completedAt: null }} />
    ) : null;
    const status = <ThreadStatusMark status="working" />;
    return props.columns ? (
      <SidebarThreadColumns
        caret={caret}
        provider={icon}
        name={name}
        wideName
        count={count}
        time={time}
        status={status}
      />
    ) : (
      <>
        {caret ?? <SidebarCaretSlot />}
        {icon}
        {name}
        <span className="ms-auto shrink-0 tabular-nums">{time}</span>
        {status}
      </>
    );
  };
  const groupName = (
    <span className="flex min-w-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger render={<span className="fork-sidebar-title min-w-0 flex-1 truncate" />}>
          {group.label}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {group.count > 1
            ? `${group.count} processes, such as ${group.commandLine}`
            : group.commandLine}
        </TooltipPopup>
      </Tooltip>
      {!props.columns && group.count > 1 ? (
        <span className="shrink-0 text-2xs">×{group.count}</span>
      ) : null}
    </span>
  );
  const content = rowContent(
    groupName,
    group.startedAt,
    expandable ? <SidebarCaretSlot open={open} /> : undefined,
    group.count > 1 ? group.count : undefined,
  );
  const buttonClass = cn(props.className, "w-full cursor-pointer text-left hover:bg-accent");
  const single = group.count === 1 ? members[0] : undefined;
  return (
    <>
      <li style={props.style}>
        {expandable ? (
          <button
            type="button"
            className={buttonClass}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${group.label} processes`}
            onClick={() => setExpanded([key], !open)}
          >
            {content}
          </button>
        ) : single ? (
          <ProcessDetails member={single}>
            <button type="button" className={buttonClass}>
              {content}
            </button>
          </ProcessDetails>
        ) : (
          <div className={props.className}>{content}</div>
        )}
      </li>
      {expandable && open ? (
        <>
          {members.map((member) => (
            <li key={`${member.pid}:${member.startedAt}`} style={props.style}>
              <ProcessDetails member={member}>
                <button type="button" className={buttonClass}>
                  {rowContent(
                    <span className="fork-sidebar-title block truncate">
                      {commandDisplayText(member.commandLine)} · {member.pid}
                    </span>,
                    member.startedAt,
                  )}
                </button>
              </ProcessDetails>
            </li>
          ))}
          {group.count > members.length ? (
            <li style={props.style}>
              <div className={props.className}>
                {props.columns ? (
                  <SidebarThreadColumns
                    name={
                      <span className="fork-sidebar-title">
                        +{group.count - members.length} more
                      </span>
                    }
                    wideName
                  />
                ) : (
                  <span className="fork-sidebar-title">+{group.count - members.length} more</span>
                )}
              </div>
            </li>
          ) : null}
        </>
      ) : null}
    </>
  );
}
