/**
 * Reading agent shell commands without running them: a tokenizer, the simple commands a command
 * line runs, and what kind of program it mostly runs (`classifyShellCommand`), which background
 * task rows show as an icon.
 *
 * A small tokenizer, not a shell: quotes, escapes, separators, redirects and heredocs. A `$NAME`
 * stays in its word as `\0NAME\0`; a word it cannot know statically (`$(…)`, a glob, `~user`) is
 * marked `dynamic`.
 */

export type ShellToken =
  | { readonly word: string; readonly dynamic: boolean }
  | { readonly op: string };

// A `$NAME` in a word, resolved later against the assignments seen so far.
const VAR = "\0";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

export function tokenizeShell(command: string): Array<ShellToken> {
  const tokens: Array<ShellToken> = [];
  const heredocs: Array<string> = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let dynamic = false;
  let i = 0;
  const endWord = () => {
    if (inWord) tokens.push({ word, dynamic });
    word = "";
    inWord = quoted = dynamic = false;
  };
  // Reads the `$…` or backtick expansion at `i`; returns the index after it.
  const expansion = (at: number): number => {
    inWord = true;
    if (command[at] === "`") {
      dynamic = true;
      const end = command.indexOf("`", at + 1);
      return end < 0 ? command.length : end + 1;
    }
    const rest = command.slice(at + 1);
    const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
    const name = braced?.[1] ?? NAME.exec(rest)?.[0];
    if (name !== undefined) {
      word += `${VAR}${name}${VAR}`;
      return at + 1 + (braced?.[0] ?? name).length;
    }
    if (rest.startsWith("(")) {
      dynamic = true;
      let depth = 0;
      for (let k = at + 1; k < command.length; k++) {
        if (command[k] === "(") depth++;
        else if (command[k] === ")" && --depth === 0) return k + 1;
      }
      return command.length;
    }
    if (rest === "" || /^[\s"]/.test(rest)) {
      word += "$";
      return at + 1;
    }
    dynamic = true;
    if (rest.startsWith("{")) {
      const end = command.indexOf("}", at);
      return end < 0 ? command.length : end + 1;
    }
    return at + 2;
  };

  while (i < command.length) {
    const c = command[i]!;
    if (c === "\\") {
      if (command[i + 1] !== "\n") word += command[i + 1] ?? "";
      inWord ||= command[i + 1] !== "\n";
      i += 2;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? command.length : end);
      inWord = quoted = true;
      i = end < 0 ? command.length : end + 1;
    } else if (c === '"') {
      inWord = quoted = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && '"\\$`'.includes(command[i + 1] ?? "")) {
          word += command[i + 1];
          i += 2;
        } else if (command[i] === "$" || command[i] === "`") {
          i = expansion(i);
        } else {
          word += command[i++];
        }
      }
      i++;
    } else if (c === "$" || c === "`") {
      i = expansion(i);
    } else if (c === "#" && !inWord) {
      const end = command.indexOf("\n", i);
      i = end < 0 ? command.length : end;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endWord();
      tokens.push({ op: ";" });
      i++;
      // Skip each pending heredoc's body, through its delimiter line.
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end < 0 ? command.length : end);
          i = end < 0 ? command.length : end + 1;
          if (line.replace(/^\t+/, "") === delimiter) break;
        }
      }
    } else if (c === ">" || c === "<" || (c === "&" && command[i + 1] === ">")) {
      // A bare number before the operator is its file descriptor, not a word.
      if (!quoted && !dynamic && /^\d+$/.test(word)) inWord = false;
      endWord();
      if (c === "&") i++;
      const direction = command[i]!;
      i++;
      if (direction === "<" && command[i] === "<") {
        i++;
        if (command[i] === "<") {
          i++;
          tokens.push({ op: "<" });
          continue;
        }
        if (command[i] === "-") i++;
        const delimiter = /^\s*(\S+)/.exec(command.slice(i));
        if (delimiter) {
          heredocs.push(delimiter[1]!.replace(/["'\\]/g, ""));
          i += delimiter[0].length;
        }
        continue;
      }
      if (command[i] === direction || command[i] === "|") i++;
      if (command[i] === "&") {
        i++;
        tokens.push({ op: "<" }); // 2>&1: its operand is a descriptor, not a file.
      } else {
        tokens.push({ op: direction });
      }
    } else if (";&|()".includes(c)) {
      endWord();
      const pair = command.slice(i, i + 2);
      const op = pair === "&&" || pair === "||" || pair === ";;" ? pair : c;
      tokens.push({ op });
      i += op.length;
    } else {
      if (c === "~" && !inWord && /^(\/|\s|$)/.test(command.slice(i + 1, i + 2))) {
        word += `${VAR}HOME${VAR}`;
      } else {
        if ("*?[".includes(c)) dynamic = true;
        if (c === "~" && !inWord) dynamic = true;
        word += c;
      }
      inWord = true;
      i++;
    }
  }
  endWord();
  return tokens;
}

/**
 * The simple commands `command` runs, in order, as their words: split at `;`, `&&`, `||`, `|`,
 * `&`, parentheses and newlines, with redirects and their targets left out and each `$NAME`
 * written back as `$NAME`. Keywords (`while`, `do`, …) stay as words.
 */
export function shellCommandWords(command: string): Array<Array<string>> {
  const commands: Array<Array<string>> = [];
  let words: Array<string> = [];
  const tokens = tokenizeShell(command);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!;
    if ("word" in token) {
      words.push(token.word.replace(/\0([^\0]*)\0/g, "$$$1"));
    } else if (token.op === ">" || token.op === "<") {
      if (tokens[k + 1] !== undefined && "word" in tokens[k + 1]!) k++;
    } else {
      if (words.length > 0) commands.push(words);
      words = [];
    }
  }
  if (words.length > 0) commands.push(words);
  return commands;
}

/** Literal PIDs targeted by common wait forms; null means at least one target is unresolved. */
export function shellCommandWaitPids(command: string): Array<number> | null {
  const pids = new Set<number>();
  let unresolved = false;
  const add = (value: string | undefined) => {
    if (!value || !/^[1-9][0-9]*$/.test(value)) {
      unresolved = true;
      return;
    }
    const pid = Number(value);
    if (Number.isSafeInteger(pid)) pids.add(pid);
    else unresolved = true;
  };
  for (const words of shellCommandWords(command)) {
    for (let index = 0; index < words.length; index++) {
      const name = words[index]!.slice(words[index]!.lastIndexOf("/") + 1);
      if (
        name === "kill" &&
        (index === 0 || ["if", "while", "until", "then", "do"].includes(words[index - 1]!))
      ) {
        const args = words.slice(index + 1);
        const signal = args.findIndex(
          (arg, argIndex) =>
            arg === "-0" ||
            arg === "--signal=0" ||
            ((arg === "-s" || arg === "--signal") && args[argIndex + 1] === "0"),
        );
        if (signal >= 0) {
          const signalEnd =
            args[signal] === "-s" || args[signal] === "--signal" ? signal + 2 : signal + 1;
          for (const target of args.slice(signalEnd).filter((arg) => arg !== "--")) add(target);
        }
      } else if (index === 0 && name === "tail") {
        const args = words.slice(1);
        const option = args.findIndex((arg) => arg === "--pid" || arg.startsWith("--pid="));
        if (option >= 0) {
          add(args[option]!.startsWith("--pid=") ? args[option]!.slice(6) : args[option + 1]);
        }
      } else if (index === 0 && name === "wait") {
        for (const arg of words.slice(1).filter((value) => !["-n", "-f", "--"].includes(value))) {
          add(arg);
        }
      }
    }
  }
  return unresolved ? null : [...pids];
}

/** What a background shell mostly runs; `shell` when nothing more specific is recognized. */
export type ShellCommandKind =
  | "server"
  | "python"
  | "pytest"
  | "bash"
  | "uv"
  | "conda"
  | "node"
  | "bun"
  | "rust"
  | "go"
  | "java"
  | "r"
  | "julia"
  | "ruby"
  | "c"
  | "cpp"
  | "make"
  | "docker"
  | "latex"
  | "git"
  | "watcher"
  | "shell";

const PROGRAM_KINDS: Record<string, ShellCommandKind> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  dash: "bash",
  python: "python",
  ipython: "python",
  jupyter: "python",
  pip: "python",
  poetry: "python",
  pipenv: "python",
  pytest: "pytest",
  "py.test": "pytest",
  uv: "uv",
  uvx: "uv",
  conda: "conda",
  mamba: "conda",
  micromamba: "conda",
  pixi: "conda",
  node: "node",
  npm: "node",
  npx: "node",
  pnpm: "node",
  pnpx: "node",
  yarn: "node",
  vp: "node",
  vpr: "node",
  tsx: "node",
  "ts-node": "node",
  deno: "node",
  tsc: "node",
  vitest: "node",
  jest: "node",
  bun: "bun",
  bunx: "bun",
  cargo: "rust",
  rustc: "rust",
  rustup: "rust",
  go: "go",
  java: "java",
  javac: "java",
  mvn: "java",
  gradle: "java",
  gradlew: "java",
  kotlin: "java",
  sbt: "java",
  R: "r",
  Rscript: "r",
  julia: "julia",
  ruby: "ruby",
  bundle: "ruby",
  rake: "ruby",
  rails: "ruby",
  gem: "ruby",
  gcc: "c",
  cc: "c",
  clang: "c",
  "g++": "cpp",
  "c++": "cpp",
  "clang++": "cpp",
  make: "make",
  cmake: "make",
  ninja: "make",
  just: "make",
  meson: "make",
  bazel: "make",
  docker: "docker",
  "docker-compose": "docker",
  podman: "docker",
  latexmk: "latex",
  latex: "latex",
  pdflatex: "latex",
  xelatex: "latex",
  lualatex: "latex",
  tectonic: "latex",
  bibtex: "latex",
  biber: "latex",
  git: "git",
  gh: "git",
  sleep: "watcher",
  wait: "watcher",
  inotifywait: "watcher",
  inotifywatch: "watcher",
  watch: "watcher",
};

// Watchers and git only name the task when nothing else in it does: `while kill -0 …; do sleep 20;
// done; python report.py` is python, and `git pull && make` is make.
const WEAK_KINDS: ReadonlyArray<ShellCommandKind> = ["watcher", "git"];

// Programs that run another command: the short options that take a value, and how many operands
// (a duration, a lock file) come before the command.
const WRAPPERS: Record<string, { readonly withValue: string; readonly operands?: number }> = {
  nohup: { withValue: "" },
  setsid: { withValue: "" },
  exec: { withValue: "a" },
  command: { withValue: "" },
  builtin: { withValue: "" },
  stdbuf: { withValue: "ioe" },
  nice: { withValue: "n" },
  ionice: { withValue: "cnpP" },
  timeout: { withValue: "sk", operands: 1 },
  time: { withValue: "fo" },
  env: { withValue: "uCS" },
  sudo: { withValue: "ugUCDhprT" },
  flock: { withValue: "wEc", operands: 1 },
  taskset: { withValue: "", operands: 1 },
  chrt: { withValue: "", operands: 1 },
  xargs: { withValue: "nIPLdEsa" },
};

// `uv run pytest`: runners whose `run` (or, for uvx, first operand) names the program they run.
const RUNNERS: Record<string, ReadonlySet<string>> = {
  uv: new Set(["--with", "--project", "--python", "-p", "--directory", "--package", "--group"]),
  uvx: new Set(["--with", "--from", "--python", "-p"]),
  conda: new Set(["-n", "--name", "-p", "--prefix", "--cwd"]),
  mamba: new Set(["-n", "--name", "-p", "--prefix", "--cwd"]),
  micromamba: new Set(["-n", "--name", "-p", "--prefix", "--cwd"]),
  pixi: new Set(["-e", "--environment", "--manifest-path"]),
  poetry: new Set(["-C", "--directory"]),
  pipenv: new Set([]),
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time"]);

/** Drops leading options (and the values of those in `withValue`) from `words`. */
function skipOptions(words: Array<string>, withValue: string | ReadonlySet<string>): Array<string> {
  let k = 0;
  while (k < words.length && words[k]!.startsWith("-") && words[k] !== "-") {
    const word = words[k++]!;
    if (word === "--") break;
    const takesValue =
      typeof withValue === "string"
        ? !word.startsWith("--") && word.length === 2 && withValue.includes(word[1]!)
        : withValue.has(word);
    if (takesValue) k++;
  }
  return words.slice(k);
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** The kind of program one simple command runs, or null when it is not one this knows. */
function programKind(
  input: Array<string>,
  nested: (script: string) => ShellCommandKind | null,
): ShellCommandKind | null {
  let words = input;
  while (words.length > 0 && KEYWORDS.has(words[0]!)) words = words.slice(1);
  for (;;) {
    while (words.length > 0 && ASSIGNMENT.test(words[0]!)) words = words.slice(1);
    const wrapper = WRAPPERS[basename(words[0] ?? "")];
    if (wrapper === undefined) break;
    words = skipOptions(words.slice(1), wrapper.withValue).slice(wrapper.operands ?? 0);
  }
  if (words.length === 0) return null;
  const name = basename(words[0]!).replace(/^(python|pip)[\d.]*$/, "$1");
  const args = words.slice(1);
  if (/^(ba|z|da|k)?sh$/.test(name)) {
    // `bash -lc '<script>'`, the way Codex runs every command.
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    return flag < 0 || args[flag + 1] === undefined ? "bash" : nested(args[flag + 1]!);
  }
  // ponytail: command names and listen flags are a heuristic; custom scripts can fool it.
  // Add an explicit provider server hint if command inspection stops being sufficient.
  if (
    args.some((arg) => /^--(?:port|host)(?:=|$)/.test(arg)) ||
    ["uvicorn", "gunicorn", "http.server"].includes(name) ||
    (name === "vite" && !["build", "optimize"].includes(args[0] ?? "")) ||
    (["next", "astro"].includes(name) && ["dev", "start", "preview"].includes(args[0] ?? "")) ||
    (name === "flask" && args.includes("run")) ||
    (name === "jupyter" && ["lab", "notebook"].includes(args[0] ?? "")) ||
    (name === "quarto" && args[0] === "preview") ||
    (name === "hugo" && args[0] === "server") ||
    (name === "mkdocs" && args[0] === "serve") ||
    (["npm", "pnpm", "yarn", "bun", "vp", "vpr"].includes(name) &&
      /^(?:run\s+)?(?:dev|serve|preview|start)$/.test(
        args.slice(0, args[0] === "run" ? 2 : 1).join(" "),
      ))
  ) {
    return "server";
  }
  if (["npx", "bunx"].includes(name)) {
    return programKind(skipOptions(args, "p"), nested) === "server"
      ? "server"
      : (PROGRAM_KINDS[name] ?? null);
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && args[0] === "exec") {
    return programKind(args.slice(1), nested) === "server"
      ? "server"
      : (PROGRAM_KINDS[name] ?? null);
  }
  if (name === "python" && args[0] === "-m" && args[1] !== undefined) {
    return programKind(args.slice(1), nested) ?? "python";
  }
  if (
    name === "kill" &&
    args.some(
      (arg, index) =>
        arg === "-0" ||
        arg === "--signal=0" ||
        ((arg === "-s" || arg === "--signal") && args[index + 1] === "0"),
    )
  ) {
    return "watcher";
  }
  if (
    name === "tail" &&
    args.some(
      (arg) =>
        arg === "--pid" ||
        arg.startsWith("--pid=") ||
        arg === "--follow" ||
        arg.startsWith("--follow=") ||
        /^-[^-]*[fF]/.test(arg),
    )
  ) {
    return "watcher";
  }
  const runner = RUNNERS[name];
  if (runner !== undefined) {
    const rest = name === "uvx" ? args : args[0] === "run" ? args.slice(1) : null;
    const runs: ShellCommandKind | null =
      rest === null ? null : programKind(skipOptions(rest, runner), nested);
    if (runs !== null && runs !== "shell") return runs;
  }
  return PROGRAM_KINDS[name] ?? null;
}

/**
 * The kind of program a background shell's command mostly runs: the first command this
 * recognizes, looking through wrappers (`nohup`, `setsid`, `timeout`, `nice`, env assignments,
 * `bash -lc '…'`), paths (`.venv/bin/python`) and runners (`python -m pytest`, `uv run`). A
 * command that only sleeps, waits or polls (`while kill -0 123; do sleep 20; done`) is a watcher.
 */
export function classifyShellCommand(command: string): ShellCommandKind {
  const weak: Array<ShellCommandKind> = [];
  let hasLoop = false;
  const scan = (source: string): ShellCommandKind | null => {
    let firstKind: ShellCommandKind | null = null;
    for (const words of shellCommandWords(source)) {
      if (words.some((word) => word === "while" || word === "until")) hasLoop = true;
      const kind = programKind(words, scan);
      if (kind === null || kind === "shell") continue;
      if (kind === "server") return kind;
      if (!WEAK_KINDS.includes(kind)) firstKind ??= kind;
      else weak.push(kind);
    }
    return firstKind;
  };
  return (
    scan(command) ??
    WEAK_KINDS.find((kind) => weak.includes(kind)) ??
    (hasLoop ? "watcher" : "shell")
  );
}
