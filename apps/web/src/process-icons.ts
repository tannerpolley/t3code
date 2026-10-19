// Keep Process Monitor’s order: the first matching brand wins.
const BRAND_ICONS = [
  ["nodedotjs", ["node", "nodejs", "node_repl"]],
  ["python", ["python*"]],
  ["typescript", ["tsc", "tsserver"]],
  ["openai", ["codex", "codex-*"]],
  ["anthropic", ["claude"]],
  ["deno", ["deno"]],
  ["bun", ["bun"]],
  ["openjdk", ["java"]],
  ["ruby", ["ruby"]],
  ["perl", ["perl"]],
  ["docker", ["dockerd", "containerd", "containerd-shim-*", "docker-proxy", "docker-init"]],
  ["nginx", ["nginx"]],
  ["gnubash", ["bash", "sh", "zsh", "dash"]],
  ["tmux", ["tmux", "tmux: server"]],
  ["git", ["git"]],
  ["uv", ["uv"]],
  ["npm", ["npm"]],
  ["gnu", ["gcc", "g++", "cc1", "cc1plus", "ld"]],
  ["cplusplus", ["c++"]],
  ["llvm", ["clang*"]],
  ["rust", ["rustc", "cargo"]],
  ["go", ["go"]],
  ["tailscale", ["tailscaled"]],
  ["gnome", ["gnome-*", "gsd-*", "gjs", "gtk4-broadwayd"]],
  ["xdotorg", ["xorg", "xwayland"]],
  ["googlechrome", ["chrome-headless-shell", "chrome_crashpad_handler"]],
  ["zotero", ["zotero-bin"]],
  ["steam", ["steamwebhelper"]],
  ["android", ["adb"]],
] as const;

export type ProcessIconKind = (typeof BRAND_ICONS)[number][0] | "terminal" | "build";
// Build tools without brand artwork.
const BUILD_PROGRAMS = new Set(["ninja", "make", "gmake", "ccache"]);
const TERMINAL_PROGRAMS = new Set([
  "tail",
  "ugrep",
  "grep",
  "rg",
  "find",
  "sed",
  "awk",
  "cat",
  "less",
]);

/** The first matching brand wins, then the generic terminal and build marks. */
export function processIconKind(name: string): ProcessIconKind | null {
  const candidate = name.toLowerCase();
  for (const [slug, patterns] of BRAND_ICONS) {
    // The source table uses only literal names and trailing-star shell patterns.
    if (
      patterns.some((pattern) =>
        pattern.endsWith("*") ? candidate.startsWith(pattern.slice(0, -1)) : candidate === pattern,
      )
    )
      return slug;
  }
  if (TERMINAL_PROGRAMS.has(candidate)) return "terminal";
  return BUILD_PROGRAMS.has(candidate) ? "build" : null;
}
