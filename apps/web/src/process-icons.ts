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

export type ProcessIconKind = (typeof BRAND_ICONS)[number][0] | "terminal";
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

/** Match the process name before argv0's basename, as in Process Monitor. */
export function processIconKind(name: string, argv0 = ""): ProcessIconKind | null {
  const candidates = [name.toLowerCase(), argv0.split("/").at(-1)!.toLowerCase()];
  for (const candidate of candidates) {
    for (const [slug, patterns] of BRAND_ICONS) {
      // The source table uses only literal names and trailing-star shell patterns.
      if (
        patterns.some((pattern) =>
          pattern.endsWith("*")
            ? candidate.startsWith(pattern.slice(0, -1))
            : candidate === pattern,
        )
      )
        return slug;
    }
  }
  return candidates.some((candidate) => TERMINAL_PROGRAMS.has(candidate)) ? "terminal" : null;
}
