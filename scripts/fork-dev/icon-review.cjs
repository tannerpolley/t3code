const path = require("path");
const lucide = require(
  require.resolve("lucide", { paths: [path.join(__dirname, "../../apps/web")] }),
);
const C = {
  muted: "#a1a1aa",
  info: "#38bdf8",
  warning: "#f59e0b",
  success: "#22c55e",
  error: "#ef4444",
  emerald: "#6ee7b7",
  sky: "#7dd3fc",
  red: "#fca5a5",
  violet: "#c4b5fd",
  zinc: "#a1a1aa",
  indigo: "#a5b4fc",
  destructive: "#f87171",
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function svg(name, color = C.muted, size = 18) {
  const node = lucide[name];
  if (!node) throw new Error("missing icon " + name);
  const inner = node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(" ")}/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
const dot = (color) =>
  `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>`;
const custom = (label) => `<span class="custom">${esc(label)}</span>`;
// [icon html, name, meaning, flag?]
const I = (name, meaning, color, flag) => [svg(name, color), name, meaning, flag];
const sections = [
  [
    "Sidebar thread row: location column",
    "Shown on the lead agent of each location.",
    [
      I(
        "FolderRoot",
        'Main local checkout ("Local")',
        C.muted,
        "Thread details uses plain Folder for the same thing",
      ),
      I("FolderGit", "Existing worktree", C.muted),
      I(
        "FolderGit2",
        "Worktree still being prepared",
        C.muted,
        'The toolbar uses this for "New worktree"',
      ),
      I(
        "Bot",
        "Native subagent mark (a provider's own subagent; you direct it through its parent)",
        C.muted,
        'Bot also means "Start agent" in the Issues pane',
      ),
    ],
  ],
  [
    "Sidebar thread row: role column",
    "Every thread has one. Default: top-level outside a worktree → Orchestrator; worktree or child → Implementor.",
    [
      I("Network", "Orchestrator", C.muted),
      I("Wrench", "Implementor", C.muted),
      I("ShieldCheck", "Reviewer", C.muted),
      I("Search", "Investigator", C.muted, "Same glyph as every search field"),
      I("ListChecks", "Checker", C.muted, "Same glyph as an issue's sub-issue progress"),
    ],
  ],
  [
    "Sidebar thread row: provider column",
    "",
    [
      [custom("OpenAI"), "OpenAI glyph", "Codex"],
      [custom("Claude"), "Claude glyph", "Claude"],
      I(
        "CornerDownRight",
        "Fallback when the thread's provider isn't known (reads as a child link)",
        C.muted,
      ),
    ],
  ],
  [
    "Sidebar thread row: status column (right edge)",
    "",
    [
      I("LoaderCircle", "Working", C.info),
      I(
        "LoaderCircle",
        "Waiting: own turn done, subagents or background tasks still running (half speed)",
        C.warning,
      ),
      [dot(C.success), "green dot", "Done while you were away, not opened yet"],
      [
        dot("rgba(161,161,170,.35)"),
        "gray dot",
        "Ready / idle (keeps the slot filled so times don't shift)",
      ],
      I(
        "CircleAlert",
        "Approval needed",
        C.warning,
        'Activity sidebar uses ShieldQuestion for approval; CircleAlert also means "blocked" for issues',
      ),
      I("MessageCircleQuestion", "Agent is asking you a question", C.warning),
      I("CircleX", "Failed", C.error),
      I("Clock", "Limited (usage or rate limit)", C.warning, "Clock also marks a watcher command"),
    ],
  ],
  [
    "Environment machine",
    "Where an environment runs, on its badges and selectors.",
    [
      I("Monitor", "Machine: desktop (also the default when unknown)", C.muted),
      I("Laptop", "Machine: laptop", C.muted),
      I("Server", "Machine: server", C.muted, 'Server also marks a "Running server" command'),
      I("Cloud", "Machine: cloud VM", C.muted),
      [custom("Linux"), "LinuxIcon", "Machine: Linux / WSL"],
      [custom("Mini PC"), "MacMiniIcon", "Machine: Mini PC"],
      [custom("Workstation"), "MacStudioIcon", "Machine: workstation"],
    ],
  ],
  [
    "Commands and processes under a thread",
    "Collapsed by default into one summary row.",
    [
      I("ChevronRight", "Summary row toggle / caret (rotates when open)", C.muted),
      I("Terminal", "Shell command or background task (default)", C.muted),
      I("Server", "Command kind: running server", C.muted),
      I("Clock", "Command kind: watcher / monitor loop", C.muted),
      [
        custom("file-type"),
        "PierreEntryIcon",
        "Recognised program (python, node, rust, docker…): that language's file-type icon",
      ],
      I("Cpu", "Process group (one row per program kind, ×count)", C.muted),
      I("Square", "Stop this task (on hover)", C.muted),
    ],
  ],
  [
    "Thread details pane",
    "",
    [
      I("Folder", "Workspace row: local checkout", C.muted, "Sidebar uses FolderRoot for Local"),
      I("FolderGit", "Workspace row: existing worktree", C.muted),
      I("FolderGit2", "Workspace row: new worktree", C.muted, 'Sidebar uses this for "preparing"'),
      I("Scale", "Environment: auto balance", C.muted),
      I(
        "CircleDot",
        "Linked issue row",
        C.muted,
        "Doesn't follow issue state like the Issues pane icons do",
      ),
      I("List", "Browse all issues", C.muted),
      I("Plus", "Show more / Minus: show less", C.muted),
    ],
  ],
  [
    "Issues pane: state icons",
    "Styled to match the PR pane.",
    [
      I("CircleDot", "Open", C.emerald),
      I(
        "CircleDotDashed",
        'In progress (agent working or waiting on you, or Project status "In progress")',
        C.sky,
      ),
      I("CircleAlert", "Blocked (an open blocker exists)", C.red),
      I("CircleCheck", "Closed as completed (or closed with no reason)", C.violet),
      I("CircleSlash", "Closed as not planned / duplicate", C.zinc),
    ],
  ],
  [
    "Issues pane: rows, roadmap and detail",
    "",
    [
      I("ListChecks", "Sub-issue progress (2/5)", C.muted, "Same glyph as the Checker role"),
      I("GitPullRequestArrow", "Linked pull request count", C.muted),
      I("MessageSquare", "Comment count", C.muted),
      I("Radio", "Roadmap: an agent is working on it", C.success),
      I("CirclePause", "Roadmap: a linked thread is waiting on you", C.warning),
      I("Link", "Roadmap: linked thread, idle", C.muted),
      I("Lock", "Private repository", C.muted),
      I("Pin", "Pin repository (PinOff to unpin)", C.muted),
      I("ListFilter", "Filter menu", C.muted),
      I("ArrowLeft", "Back to the list", C.muted),
      I("ExternalLink", "Open on GitHub (tinted by state)", C.emerald),
      I("PanelRight", "Open beside thread", C.muted),
      I("GitBranchPlus", "Prepare draft (start in a worktree)", C.muted),
      I("Bot", "Start agent", C.muted, "Same glyph as the native subagent mark"),
    ],
  ],
  [
    "Pull requests pane (upstream, for comparison)",
    "",
    [
      I("GitPullRequestArrow", "Open pull request", C.emerald),
      I("GitPullRequestDraft", "Draft", C.zinc),
      I("GitPullRequestClosed", "Closed (not merged)", C.red),
      I("GitMerge", "Merged", C.violet),
      I("TriangleAlert", "Merge conflict badge", C.destructive),
    ],
  ],
];
const total = sections.reduce((n, [, , items]) => n + items.length, 0);
const flagged = sections.reduce((n, [, , items]) => n + items.filter((i) => i[3]).length, 0);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>T3 fork icon review</title><style>
main{margin:0;padding:0}p.lead{color:var(--muted-foreground);margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
h2{font-size:13px;margin:0 0 2px}section>p{color:var(--muted-foreground);margin:0 0 8px;font-size:12px}
.row{display:grid;grid-template-columns:24px 118px 1fr;align-items:start;gap:8px;padding:5px 0;border-top:1px solid var(--border)}
.row:first-of-type{border-top:0}.ic{display:flex;justify-content:center;padding-top:1px}
.nm{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);padding-top:2px;word-break:break-word}
.flag{display:block;color:var(--warning);font-size:11.5px;margin-top:2px}.flag::before{content:"⚠ "}
.custom{font-size:9px;border:1px solid var(--border);border-radius:4px;padding:1px 3px;color:var(--muted-foreground);white-space:nowrap}
</style></head><body><main><p class="lead">${total} icon uses across the sidebar, thread details, Issues and Pull requests panes, as they render in the current preview (dev instance). <span style="color:var(--warning)">⚠</span> marks ${flagged} where one glyph means two things or one thing has two glyphs.</p>
<div class="grid">${sections.map(([title, note, items]) => `<section><h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ""}${items.map(([icon, name, meaning, flag]) => `<div class="row"><div class="ic">${icon}</div><div class="nm">${esc(name)}</div><div>${esc(meaning)}${flag ? `<span class="flag">${esc(flag)}</span>` : ""}</div></div>`).join("")}</section>`).join("")}</div></main></body></html>`;
const out = path.join(process.env.HOME, "Workspaces-Dev/.t3-dev-fixture/shots");
require("fs").mkdirSync(out, { recursive: true });
require("fs").writeFileSync(path.join(out, "icon-review.html"), html);
console.log("written", total, "uses,", flagged, "flagged");
