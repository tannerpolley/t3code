// @effect-diagnostics nodeBuiltinImport:off
// Runs the server in watch mode on source folders only. Plain `node --watch` also watches
// imported files under the shared pnpm store, and package installs in other worktrees touch
// those hardlinks' metadata, restarting this server. Arguments pass through to `src/bin.ts`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const packagesDir = NodePath.join(import.meta.dirname, "../../../packages");
const watchPaths = [
  "src",
  "package.json",
  ...NodeFS.readdirSync(packagesDir)
    .map((name) => NodePath.join(packagesDir, name, "src"))
    .filter((path) => NodeFS.existsSync(path)),
];

const child = NodeChildProcess.spawn(
  process.execPath,
  [...watchPaths.map((path) => `--watch-path=${path}`), "src/bin.ts", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
