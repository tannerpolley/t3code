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
  ["c++", "cplusplus"],
  ["ninja", "build"],
  ["unknown-program", null],
  ["not-python3", null],
])("matches %s", (name, expected) => {
  expect(processIconKind(name)).toBe(expected);
});
