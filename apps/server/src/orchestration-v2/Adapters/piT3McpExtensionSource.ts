/**
 * Source for the T3-owned Pi extension that consumes T3's HTTP MCP server.
 *
 * This bridge owns its MCP client. Pi loads this TypeScript via
 * `--extension`. It is written to a cache path at session open so packaged
 * AppImage builds do not need a sibling .ts file next to the bundled server.
 *
 * Do not import t3code modules from the string body. The Pi process resolves
 * `@earendil-works/pi-coding-agent` and `typebox` from the user's pi install.
 */
export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";
export const T3_PI_BACKGROUND_JOB_DIR_ENV = "T3_PI_BACKGROUND_JOB_DIR";
export const PI_BACKGROUND_JOB_ENTRY_TYPE = "t3_background_job";
export const PI_BACKGROUND_JOB_TOOL_NAME = "mcp__t3-code__background_job";
/** T3's system-prompt addition, built by the server's shared instruction builders. */
export const T3_PI_INSTRUCTIONS_ENV = "T3_PI_INSTRUCTIONS";

/**
 * Pi tools whose confirmations the bridge raises as file-change approvals.
 * Auto-accept edits skips them; the adapter keys the approval kind off them.
 */
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

export const PI_T3_MCP_EXTENSION_SOURCE = `\
import { getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const INSTRUCTIONS_ENV = ${JSON.stringify(T3_PI_INSTRUCTIONS_ENV)};
const BACKGROUND_JOB_DIR_ENV = ${JSON.stringify(T3_PI_BACKGROUND_JOB_DIR_ENV)};
const BACKGROUND_JOB_ENTRY_TYPE = ${JSON.stringify(PI_BACKGROUND_JOB_ENTRY_TYPE)};
const BACKGROUND_JOB_TOOL_NAME = ${JSON.stringify(PI_BACKGROUND_JOB_TOOL_NAME)};
const backgroundJobs = new Map<string, { pid: number; completion: Promise<void> }>();
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}


// ponytail: shell-token heuristic, not a shell parser; nested scripts can hide operators.
function backgroundsCommand(command: string): boolean {
  let unquoted = "";
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\\\" && quote !== "'") {
      index += 1;
      unquoted += " ";
    } else if (quote) {
      if (char === quote) quote = "";
      unquoted += " ";
    } else if (char === "'" || char === '"') {
      quote = char;
      unquoted += " ";
    } else if (char === "#" && (index === 0 || /[\\s;|&()<>]/.test(command[index - 1]!))) {
      while (index + 1 < command.length && command[index + 1] !== "\\n") index += 1;
      unquoted += " ";
    } else {
      unquoted += char;
    }
  }
  return /(^|[;\\n|&])\\s*(?:exec\\s+|sudo\\s+|env\\s+)*(?:[\\w./-]*\\/)?(?:nohup|setsid|disown)\\b/.test(unquoted) ||
    /(?<![&<>|])&(?![&>])/.test(unquoted);
}

function killBackgroundJob(pid: number, allowExited = false): void {
  if (process.platform === "win32") {
    const result = spawnSync(
      join(process.env.SystemRoot ?? "C:\\\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 10_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowExited) throw new Error("taskkill failed for background job " + pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    return unsafe(schema);
  }
  return Type.Object({}, { additionalProperties: true });
}

function formatMcpContent(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result !== "object") return String(result);
  const record = result as {
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  const texts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (record.structuredContent !== undefined) {
    texts.push(JSON.stringify(record.structuredContent));
  }
  if (texts.length > 0) return texts.join("\\n");
  return JSON.stringify(result);
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": PROTOCOL,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status}): \${body.slice(0, 400)}\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

export default async function t3McpExtension(pi: ExtensionAPI) {

  pi.registerTool({
    name: BACKGROUND_JOB_TOOL_NAME,
    label: "background_job",
    description: "Start tracked long-running shell work. T3 shows its output, supports Stop, and wakes you when it ends.",
    promptSnippet: "Start tracked background shell work; finish your turn while it runs.",
    parameters: jsonSchemaToTypebox({
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        description: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { command: string; cwd?: string; description?: string };
      if (!input.command.trim()) throw new Error("Background job command cannot be empty.");
      if (backgroundsCommand(input.command)) {
        throw new Error("Keep the background_job command in the foreground; this tool tracks it for you.");
      }
      signal?.throwIfAborted();
      const directory = env(BACKGROUND_JOB_DIR_ENV);
      if (!directory) throw new Error("T3 background job directory is unavailable.");
      const taskId = randomUUID();
      const outputDir = join(directory, "tasks");
      mkdirSync(outputDir, { recursive: true });
      const outputPath = join(outputDir, taskId + ".output");
      const config = getShellConfig(pi.getSettings().shellPath);
      const fd = openSync(outputPath, "wx", 0o600);
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => { finish = resolve; });
      try {
        const child = spawn(
          config.shell,
          config.commandTransport === "stdin" ? config.args : [...config.args, input.command],
          {
            cwd: input.cwd ?? ctx.cwd,
            detached: true,
            stdio: [config.commandTransport === "stdin" ? "pipe" : "ignore", fd, fd],
            windowsHide: true,
          },
        );
        child.once("close", (exitCode, signal) => {
          const job = backgroundJobs.get(taskId);
          try {
            if (job) {
              // Reap descendants if the shell exited before them.
              try {
                killBackgroundJob(job.pid, true);
              } catch (error) {
                ctx.ui.notify("Failed to clean up background task " + taskId + ": " + String(error), "error");
              }
              backgroundJobs.delete(taskId);
              pi.appendEntry(BACKGROUND_JOB_ENTRY_TYPE, { status: "ended", taskId, exitCode, signal });
            }
          } finally {
            finish();
          }
        });
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("spawn", () => {
            backgroundJobs.set(taskId, { pid: child.pid!, completion });
            pi.appendEntry(BACKGROUND_JOB_ENTRY_TYPE, {
              status: "started", taskId, pid: child.pid!,
              description: input.description?.trim() || input.command,
              command: input.command, startedAt: new Date().toISOString(),
            });
            if (config.commandTransport === "stdin") child.stdin!.end(input.command);
            resolve();
          });
        });
      } finally {
        closeSync(fd);
      }
      return {
        content: [{ type: "text", text: "Background task " + taskId + " started.\\nOutput is being written to: " + outputPath }],
        details: { taskId, outputPath },
      };
    },
  });
  pi.on("session_shutdown", async () => {
    const jobs = [...backgroundJobs.values()];
    for (const job of jobs) killBackgroundJob(job.pid);
    await Promise.all(jobs.map((job) => job.completion));
  });

  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" &&
      typeof event.input.command === "string" && backgroundsCommand(event.input.command)) {
      return { block: true, reason: "Use " + BACKGROUND_JOB_TOOL_NAME + " for background work so T3 can show output, Stop it, and wake you when it ends." };
    }
    const mode = runtimeMode();
    if (mode === "full-access" || READ_ONLY_TOOLS.has(event.toolName)) return;
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in T3 Code.\` };
    }
  });

  // Deliver T3 guidance through pi's real system-prompt channel.
  // Wrapping the first user message instead would stop it from starting
  // with "/" and silently break slash-command expansion.
  const instructions = env(INSTRUCTIONS_ENV);
  let deferredTools = false;
  if (instructions !== undefined) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt:
        event.systemPrompt +
        "\\n\\n" +
        instructions +
        (deferredTools
          ? "\\n\\nT3 tools load through tool_search; search for the named T3 tool before calling it."
          : ""),
    }));
  }

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
    return;
  }

  const client = createMcpClient(endpoint, token);
  const registerTools = (tools: McpTool[], deferred: boolean) => {
    for (const tool of tools) {
      const name = tool.name;
      const registeredName = \`mcp__t3-code__\${name}\`;
      const description = tool.description ?? name;
      pi.registerTool({
        name: registeredName,
        label: name,
        description,
        ...(deferred ? { exposure: "deferred" as const } : {}),
        promptSnippet: description.split("\\n")[0] ?? name,
        parameters: jsonSchemaToTypebox(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          const result = await client.callTool(
            name,
            (params ?? {}) as Record<string, unknown>,
            signal,
          );
          const text = formatMcpContent(result);
          return {
            content: [{ type: "text", text }],
            details: { server: "t3-code", tool: name },
            ...(isMcpToolError(result) ? { isError: true } : {}),
          };
        },
      });
    }
  };
  const loadTools = async () => {
    const signal = AbortSignal.timeout(10_000);
    await client.connect(signal);
    return client.listTools(signal);
  };
  // Register before Pi restores the transcript's active tool loadout.
  // Old Pi ignores exposure; session_start selects direct tools if search is absent.
  const preloadedTools = await loadTools().catch(() => undefined);
  if (preloadedTools !== undefined) registerTools(preloadedTools, true);
  let started: Promise<void> | undefined;

  // Only Pi's built-in tool_search can load T3's deferred tools; an
  // extension's same-named replacement may search just its own catalog.
  const activateToolSearch = () => {
    const builtin = pi
      .getAllTools()
      .some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path?.startsWith("builtin:"));
    if (!builtin) return false;
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("tool_search")) pi.setActiveTools([...activeTools, "tool_search"]);
    return pi.getActiveTools().includes("tool_search");
  };

  const ensureStarted = () => {
    if (started !== undefined) return started;
    const attempt = (async () => {
      const tools = preloadedTools ?? (await loadTools());
      deferredTools = activateToolSearch();
      if (preloadedTools === undefined || !deferredTools) {
        registerTools(tools, deferredTools);
      }
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // Tool-catalog methods are unavailable during extension loading. Select
  // exposure after the runtime binds; retry a failed preload before the prompt.
  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(\`t3-code MCP unavailable: \${message}\`, "warning");
    }
  });

  // /tree restores the target branch's tool selection, which may predate tool_search.
  pi.on("session_tree", () => {
    if (deferredTools) activateToolSearch();
  });
}
`;
