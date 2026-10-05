import { ClockIcon, ServerIcon, TerminalIcon } from "lucide-react";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { syntheticFileNameForLanguageId } from "../../pierre-icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";

const COMMAND_KIND_LABELS: Record<string, string> = {
  server: "Running server",
  bash: "Bash",
  python: "Python",
  pytest: "pytest",
  uv: "uv",
  conda: "Conda",
  node: "Node.js",
  bun: "Bun",
  rust: "Rust",
  go: "Go",
  java: "Java",
  r: "R",
  julia: "Julia",
  ruby: "Ruby",
  c: "C",
  cpp: "C++",
  make: "Build",
  docker: "Docker",
  latex: "LaTeX",
  git: "Git",
  watcher: "Watcher",
};

const COMMAND_KIND_FILE: Record<string, string> = {
  bun: "bun.lockb",
  docker: "Dockerfile",
  git: ".gitignore",
  make: "Makefile",
};

const COMMAND_KIND_LANGUAGE: Record<string, string> = {
  bash: "bash",
  python: "python",
  pytest: "python",
  uv: "python",
  conda: "python",
  node: "javascript",
  rust: "rust",
  go: "go",
  java: "java",
  r: "r",
  julia: "julia",
  ruby: "ruby",
  c: "c",
  cpp: "cpp",
  latex: "latex",
};

export function backgroundProcessKindLabel(kind?: string, commandKind?: string): string {
  return kind === "monitor" || commandKind === "watcher"
    ? "Watcher"
    : (COMMAND_KIND_LABELS[commandKind ?? ""] ??
        (kind === "background_task" ? "Background task" : "Shell"));
}

export function BackgroundProcessKindIcon(props: {
  readonly kind: "command" | "monitor" | "background_task";
  readonly commandKind?: string | undefined;
  readonly className: string;
}) {
  const { resolvedTheme } = useTheme();
  const label = backgroundProcessKindLabel(props.kind, props.commandKind);
  const iconClassName = cn("size-4", props.className);
  const fileName = props.commandKind
    ? (COMMAND_KIND_FILE[props.commandKind] ??
      (COMMAND_KIND_LANGUAGE[props.commandKind] === undefined
        ? null
        : syntheticFileNameForLanguageId(COMMAND_KIND_LANGUAGE[props.commandKind]!)))
    : null;
  const icon =
    props.commandKind === "server" ? (
      <ServerIcon aria-hidden className={cn(iconClassName, "text-muted-foreground")} />
    ) : props.kind === "monitor" || props.commandKind === "watcher" ? (
      <ClockIcon aria-hidden className={cn(iconClassName, "text-muted-foreground")} />
    ) : fileName !== null ? (
      <PierreEntryIcon
        pathValue={fileName}
        kind="file"
        theme={resolvedTheme}
        className={props.className}
      />
    ) : (
      <TerminalIcon aria-hidden className={cn(iconClassName, "text-muted-foreground")} />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span aria-label={label} className="inline-flex shrink-0" role="img" />}
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
