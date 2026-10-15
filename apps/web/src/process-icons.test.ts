import { expect, it } from "vite-plus/test";
import { processIconKind } from "./process-icons";

it.each([
  ["node", "nodedotjs"],
  ["node_repl", "nodedotjs"],
  ["python3.12", "python"],
  ["codex-tui", "openai"],
  ["claude", "anthropic"],
  ["containerd-shim-runc-v2", "docker"],
  ["GNOME-shell", "gnome"],
  ["tail", "terminal"],
  ["ugrep", "terminal"],
  ["unknown-program", null],
  ["not-python3", null],
])("matches %s", (name, expected) => {
  expect(processIconKind(name)).toBe(expected);
});

it("falls back to argv0's basename, case-insensitively", () => {
  expect(processIconKind("unknown", "/opt/bin/PYTHON3.12")).toBe("python");
  expect(processIconKind("unknown", "/usr/bin/ugrep")).toBe("terminal");
  expect(processIconKind("unknown", "/opt/bin/unknown")).toBeNull();
});

it("tries the process name before argv0 and brands before terminal fallbacks", () => {
  expect(processIconKind("node", "/usr/bin/python3")).toBe("nodedotjs");
  expect(processIconKind("tail", "/usr/bin/node")).toBe("nodedotjs");
});
