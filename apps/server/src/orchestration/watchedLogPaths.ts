// @effect-diagnostics nodeBuiltinImport:off
/**
 * The files a shell command reads or writes, from its text: what an agent's silent wait loop or
 * detached launch is really watching. `watchedLogPaths("cd /w && until grep -q DONE run.log; do
 * sleep 20; done", cwd, home)` is `["/w/run.log"]`.
 *
 * A small tokenizer, not a shell: quotes, escapes, separators, redirects, heredocs and simple
 * `NAME=value` assignments. Any word it cannot know statically (an unknown `$VAR`, `$(…)`, a
 * glob, `~user`) is skipped rather than guessed.
 */
import * as NodePath from "node:path";

type Token = { readonly word: string; readonly dynamic: boolean } | { readonly op: string };

// A `$NAME` in a word, resolved later against the assignments seen so far.
const VAR = "\0";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(command: string): Array<Token> {
  const tokens: Array<Token> = [];
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

type Word = Extract<Token, { word: string }>;

const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time"]);
const WRAPPERS = new Set(["nohup", "setsid", "exec", "command", "builtin", "stdbuf"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
// Long options that take their value as the next word (the rest are flags or `--opt=value`).
const LONG_WITH_VALUE = new Set([
  "--pid",
  "--lines",
  "--bytes",
  "--sleep-interval",
  "--max-unchanged-stats",
  "--regexp",
  "--file",
  "--max-count",
  "--context",
  "--after-context",
  "--before-context",
  "--glob",
  "--type",
  "--type-not",
]);
// Per command: the short options that take a value, and whether its first operand is a pattern.
const READERS: Record<string, { readonly withValue: string; readonly pattern: boolean }> = {
  tail: { withValue: "ncs", pattern: false },
  head: { withValue: "nc", pattern: false },
  cat: { withValue: "", pattern: false },
  less: { withValue: "", pattern: false },
  tee: { withValue: "", pattern: false },
  grep: { withValue: "efmABCdD", pattern: true },
  egrep: { withValue: "efmABCdD", pattern: true },
  fgrep: { withValue: "efmABCdD", pattern: true },
  rg: { withValue: "efgtTmABCjM", pattern: true },
};

function operandsOf(args: ReadonlyArray<Word>, withValue: string) {
  const operands: Array<Word> = [];
  const options = new Set<string>();
  let parsingOptions = true;
  for (let k = 0; k < args.length; k++) {
    const text = args[k]!.word;
    if (!parsingOptions || text === "-" || !text.startsWith("-")) {
      operands.push(args[k]!);
    } else if (text === "--") {
      parsingOptions = false;
    } else if (text.startsWith("--")) {
      const name = text.split("=")[0]!;
      options.add(name);
      if (!text.includes("=") && LONG_WITH_VALUE.has(name)) k++;
    } else {
      for (let c = 1; c < text.length; c++) {
        options.add(text[c]!);
        if (withValue.includes(text[c]!)) {
          if (c === text.length - 1) k++;
          break;
        }
      }
    }
  }
  return { operands, options };
}

/**
 * Absolute paths of the files `command` reads with tail, head, cat, less or grep/egrep/fgrep/rg,
 * or writes through a redirect or `tee`, in order and without duplicates. Relative paths resolve
 * against `cwd` and any `cd` before them; a leading `~/` against `home`. `/dev/*` is left out,
 * and the paths are not checked to exist.
 */
export function watchedLogPaths(command: string, cwd: string, home: string): Array<string> {
  const found = new Set<string>();
  const vars = new Map([
    ["HOME", home],
    ["PWD", cwd],
  ]);
  let dir: string | null = cwd;

  const text = (token: Word): string | null => {
    if (token.dynamic) return null;
    let unknown = false;
    const value = token.word.replace(/\0([^\0]*)\0/g, (_, name: string) => {
      const known = vars.get(name);
      if (known === undefined) unknown = true;
      return known ?? "";
    });
    return unknown ? null : value;
  };
  const add = (token: Word | undefined) => {
    const path = token === undefined ? null : text(token);
    if (!path || path === "-") return;
    if (!NodePath.isAbsolute(path) && dir === null) return;
    const absolute = NodePath.resolve(dir ?? "/", path);
    if (!absolute.startsWith("/dev/")) found.add(absolute);
  };

  const runCommand = (words: Array<Word>) => {
    while (words.length > 0 && KEYWORDS.has(words[0]!.word)) words.shift();
    const assignments = words.findIndex((word) => !ASSIGNMENT.test(word.word));
    if (assignments < 0) {
      for (const word of words) {
        const name = ASSIGNMENT.exec(word.word)![1]!;
        const value = text({ word: word.word.slice(name.length + 1), dynamic: word.dynamic });
        if (value === null) vars.delete(name);
        else vars.set(name, value);
      }
      return;
    }
    words.splice(0, assignments);
    while (words.length > 0 && WRAPPERS.has(words[0]!.word)) words.shift();
    if (words.length === 0) return;
    const name = NodePath.basename(words[0]!.word);
    const args = words.slice(1);
    if (name === "cd") {
      const target = args.find((arg) => !arg.word.startsWith("-"));
      const next = target === undefined ? home : text(target);
      dir = next === null || dir === null ? null : NodePath.resolve(dir, next);
      if (dir === null) vars.delete("PWD");
      else vars.set("PWD", dir);
      return;
    }
    if (/^(ba|z|da)?sh$/.test(name)) {
      // `bash -lc '<script>'`, the way Codex runs every command.
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg.word));
      const script = flag < 0 ? undefined : args[flag + 1];
      const source = script === undefined ? null : text(script);
      if (source !== null) scan(source);
      return;
    }
    const reader = READERS[name];
    if (reader === undefined) return;
    const { operands, options } = operandsOf(args, reader.withValue);
    const patternGiven = ["e", "f", "--regexp", "--file"].some((option) => options.has(option));
    (reader.pattern && !patternGiven ? operands.slice(1) : operands).forEach(add);
  };

  const scan = (source: string) => {
    const tokens = tokenize(source);
    let words: Array<Word> = [];
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k]!;
      if ("word" in token) {
        words.push(token);
        continue;
      }
      const next = tokens[k + 1];
      const operand = next !== undefined && "word" in next ? next : undefined;
      if (token.op === ">" || token.op === "<") {
        if (token.op === ">") add(operand);
        if (operand !== undefined) k++;
        continue;
      }
      runCommand(words);
      words = [];
    }
    runCommand(words);
  };

  scan(command);
  return [...found];
}
