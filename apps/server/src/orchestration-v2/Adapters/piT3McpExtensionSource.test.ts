// Native APIs execute the generated extension exactly as the Pi process does.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";

import {
  PI_BACKGROUND_JOB_ENTRY_TYPE,
  PI_BACKGROUND_JOB_TOOL_NAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_BACKGROUND_JOB_DIR_ENV,
  T3_PI_INSTRUCTIONS_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadHooks(
  env: Record<string, string> = {},
  bindings: Record<string, unknown> & { pi?: Record<string, unknown> } = {},
): Promise<Map<string, RequestHook>> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with its host APIs supplied by the test.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    Type: { Unsafe: (schema: unknown) => schema },
    spawn: NodeChildProcess.spawn,
    spawnSync: NodeChildProcess.spawnSync,
    randomUUID: NodeCrypto.randomUUID,
    closeSync: NodeFS.closeSync,
    mkdirSync: NodeFS.mkdirSync,
    openSync: NodeFS.openSync,
    join: NodePath.join,
    getShellConfig: (shellPath?: string) => ({ shell: shellPath ?? "/bin/sh", args: ["-c"] }),
    ...bindings,
    process: {
      env,
      platform: HostProcessPlatform.defaultValue(),
      kill: process.kill.bind(process),
    },
    pi: {
      registerTool: () => undefined,
      getSettings: () => ({}),
      ...bindings.pi,
      on: (name: string, handler: RequestHook) => handlers.set(name, handler),
    },
  });
  return handlers;
}

async function loadRequestHook(): Promise<RequestHook> {
  const hook = (await loadHooks()).get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    it(`caps ${key} without changing the conversation or tools`, async () => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    });
  }

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi T3 tool discovery", () => {
  for (const discovery of ["inactive", "active", "missing", "replaced", "hidden"] as const) {
    it(`registers callable T3 tools with ${discovery} tool_search`, async () => {
      const calls: Array<{ jsonrpc?: string; id?: number; method: string; params?: unknown }> = [];
      const registered = new Map<
        string,
        {
          name: string;
          exposure?: string;
          promptGuidelines?: string[];
          execute: (
            id: string,
            params: unknown,
            signal: AbortSignal,
          ) => Promise<{
            content: Array<{ text: string }>;
            details: { server: string; tool: string };
          }>;
        }
      >();
      let active = discovery === "active" ? ["read", "tool_search"] : ["read"];
      let runtimeReady = false;
      const hooks = await loadHooks(
        {
          [T3_MCP_URL_ENV]: "http://stub/mcp",
          [T3_MCP_BEARER_ENV]: "stub-token",
          [T3_PI_INSTRUCTIONS_ENV]: "T3 instructions",
        },
        {
          AbortSignal,
          Type: { Unsafe: (schema: unknown) => schema },
          fetch: async (_url: string, options: { body: string }) => {
            const request = JSON.parse(options.body) as (typeof calls)[number];
            calls.push(request);
            if (discovery === "inactive" && calls.length === 1) {
              throw new Error("Transient preload failure");
            }
            const result =
              request.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "orchestrator_capabilities",
                        description: "Read T3 capabilities",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  }
                : { content: [{ type: "text", text: "T3 capabilities" }] };
            return {
              ok: true,
              headers: new Map([["content-type", "application/json"]]),
              text: async () => JSON.stringify({ id: 1, result }),
            };
          },
          pi: {
            getAllTools: () => {
              assert.isTrue(runtimeReady, "catalog access must wait for session_start");
              if (discovery === "missing") return [];
              const path =
                discovery === "replaced" ? "/ext/other-search.ts" : "builtin:tool-search";
              return [{ name: "tool_search", sourceInfo: { path } }];
            },
            getActiveTools: () => active,
            setActiveTools: (names: string[]) => {
              active =
                discovery === "hidden" ? names.filter((name) => name !== "tool_search") : names;
            },
            registerTool: (tool: NonNullable<ReturnType<typeof registered.get>>) =>
              registered.set(tool.name, tool),
          },
        },
      );
      assert.equal(registered.size, discovery === "inactive" ? 1 : 2);
      if (discovery !== "inactive") {
        assert.equal(
          registered.get("mcp__t3-code__orchestrator_capabilities")?.exposure,
          "deferred",
        );
      }
      runtimeReady = true;
      const start = hooks.get("session_start") as unknown as (
        event: object,
        ctx: { ui: { notify: (message: string) => void } },
      ) => Promise<void>;
      const warnings: string[] = [];
      await start({}, { ui: { notify: (message) => warnings.push(message) } });
      await start({}, { ui: { notify: (message) => warnings.push(message) } });
      assert.isEmpty(warnings);
      assert.equal(registered.size, 2);
      assert.isUndefined(registered.get(PI_BACKGROUND_JOB_TOOL_NAME)?.exposure);
      const tool = registered.get("mcp__t3-code__orchestrator_capabilities")!;
      const deferred = discovery === "active" || discovery === "inactive";
      assert.equal(tool.name, "mcp__t3-code__orchestrator_capabilities");
      assert.equal(tool.exposure, deferred ? "deferred" : undefined);
      assert.isUndefined(tool.promptGuidelines);
      assert.deepEqual(active, deferred ? ["read", "tool_search"] : ["read"]);
      const beforeStart = hooks.get("before_agent_start") as unknown as (event: {
        systemPrompt: string;
      }) => { systemPrompt: string };
      assert.equal(
        beforeStart({ systemPrompt: "Pi base" }).systemPrompt.includes("load through tool_search"),
        deferred,
      );
      const result = await tool.execute("call-1", { detail: true }, new AbortController().signal);
      assert.equal(result.content[0]?.text, "T3 capabilities");
      assert.equal(result.details.tool, "orchestrator_capabilities");
      assert.deepEqual(calls.at(-1), {
        jsonrpc: "2.0",
        id: discovery === "inactive" ? 4 : 3,
        method: "tools/call",
        params: { name: "orchestrator_capabilities", arguments: { detail: true } },
      });
    });
  }

  it("allows discovery without approval while still confirming T3 calls", async () => {
    const hook = (await loadHooks({ [T3_PI_RUNTIME_MODE_ENV]: "approval-required" })).get(
      "tool_call",
    ) as unknown as (
      event: { toolName: string; input: object },
      ctx: { ui: { confirm: (title: string) => Promise<boolean> } },
    ) => Promise<{ block: boolean } | undefined>;
    const confirmations: string[] = [];
    const ctx = {
      ui: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(await hook({ toolName: "tool_search", input: { query: "T3" } }, ctx));
    assert.isEmpty(confirmations);
    assert.isTrue((await hook({ toolName: "mcp__t3-code__delegate_task", input: {} }, ctx))?.block);
    assert.deepEqual(confirmations, ["Allow mcp__t3-code__delegate_task?"]);
  });
});

describe("Pi T3 instructions", () => {
  it("appends the server-built instructions to Pi's system prompt without MCP", async () => {
    const hook = (
      await loadHooks({ [T3_PI_INSTRUCTIONS_ENV]: "<showing_images>x</showing_images>" })
    ).get("before_agent_start") as unknown as
      | ((event: { systemPrompt: string }) => { systemPrompt: string })
      | undefined;
    assert.deepEqual(hook?.({ systemPrompt: "Pi base" }), {
      systemPrompt: "Pi base\n\n<showing_images>x</showing_images>",
    });
  });
});

type BackgroundJobTool = {
  exposure?: string;
  execute: (
    id: string,
    params: { command: string; cwd?: string; description?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<{
    content: Array<{ text: string }>;
    details: { taskId: string; outputPath: string };
  }>;
};

describe("Pi tracked background jobs", () => {
  it("uses the configured shell and retains combined output and exit status", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-background-test-"),
    );
    const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
    let tool!: BackgroundJobTool;
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const hooks = await loadHooks(
      { [T3_PI_BACKGROUND_JOB_DIR_ENV]: directory },
      {
        pi: {
          getSettings: () => ({ shellPath: "/bin/bash" }),
          registerTool: (registered: BackgroundJobTool) => {
            tool = registered;
          },
          appendEntry: (type: string, data: Record<string, unknown>) => {
            entries.push({ type, data });
            if (data.status === "ended") resolveEnd();
          },
        },
      },
    );
    const shutdown = hooks.get("session_shutdown") as unknown as () => Promise<void>;
    try {
      assert.isUndefined(tool.exposure, "background jobs are callable without tool_search or MCP");
      await NodeAssert.rejects(
        tool.execute("blocked", { command: "build &" }, undefined, undefined, { cwd: directory }),
        /foreground/,
      );
      const controller = new AbortController();
      controller.abort();
      await NodeAssert.rejects(
        tool.execute("aborted", { command: "build" }, controller.signal, undefined, {
          cwd: directory,
        }),
      );
      assert.isEmpty(entries);
      const result = await tool.execute(
        "call",
        {
          command:
            '[[ -n "$BASH_VERSION" ]] || exit 99; pwd; printf stdout; printf stderr >&2; exit 7',
          cwd: directory,
          description: "Focused check",
        },
        undefined,
        undefined,
        { cwd: "/" },
      );
      await ended;
      assert.equal(entries.length, 2);
      assert.deepInclude(entries[0], { type: PI_BACKGROUND_JOB_ENTRY_TYPE });
      assert.deepInclude(entries[0]?.data, {
        status: "started",
        taskId: result.details.taskId,
        description: "Focused check",
      });
      assert.isAbove(Number(entries[0]?.data.pid), 0);
      assert.deepEqual(entries[1]?.data, {
        status: "ended",
        taskId: result.details.taskId,
        exitCode: 7,
        signal: null,
      });
      assert.equal(
        result.details.outputPath,
        NodePath.join(directory, "tasks", result.details.taskId + ".output"),
      );
      assert.include(
        result.content[0]?.text,
        "Output is being written to: " + result.details.outputPath,
      );
      assert.equal(
        await NodeFSP.readFile(result.details.outputPath, "utf8"),
        directory + "\nstdoutstderr",
      );
    } finally {
      await shutdown();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("kills a running process group on session shutdown and reports its signal", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-background-test-"),
    );
    const entries: Array<Record<string, unknown>> = [];
    let tool!: BackgroundJobTool;
    const hooks = await loadHooks(
      { [T3_PI_BACKGROUND_JOB_DIR_ENV]: directory },
      {
        pi: {
          registerTool: (registered: BackgroundJobTool) => {
            tool = registered;
          },
          appendEntry: (_type: string, data: Record<string, unknown>) => {
            entries.push(data);
          },
        },
      },
    );
    const shutdown = hooks.get("session_shutdown") as unknown as () => Promise<void>;
    try {
      await tool.execute(
        "call",
        {
          command: `exec '${process.execPath}' -e 'require("node:net").createServer().listen(0)'`,
          description: "   ",
        },
        undefined,
        undefined,
        { cwd: directory },
      );
      assert.equal(entries.length, 1, "tool returns while job is running");
      assert.equal(entries[0]?.description, entries[0]?.command);
      await shutdown();
      assert.deepInclude(entries[1], { status: "ended", exitCode: null, signal: "SIGKILL" });
      assert.throws(() => process.kill(-Number(entries[0]?.pid), 0), /ESRCH/);
    } finally {
      await shutdown();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  for (const mode of ["full-access", "approval-required", "auto-accept-edits", "auto"]) {
    it(`blocks untracked bash jobs in ${mode} without false positives on ordinary commands`, async () => {
      const hook = (await loadHooks({ [T3_PI_RUNTIME_MODE_ENV]: mode })).get(
        "tool_call",
      ) as unknown as (
        event: { toolName: string; input: { command: string } },
        ctx: { ui: { confirm: () => Promise<boolean> } },
      ) => Promise<{ block: boolean; reason: string } | undefined>;
      const ctx = { ui: { confirm: async () => true } };
      for (const command of [
        "build &",
        "build & # detached",
        "build & wait",
        "nohup build",
        "setsid build",
        "build; disown",
        "sudo nohup build",
        "/usr/bin/setsid build",
        "build && nohup test",
        "build # commented &\nnohup test",
        "echo word#value &",
      ]) {
        const result = await hook({ toolName: "bash", input: { command } }, ctx);
        assert.isTrue(result?.block, command);
        assert.include(result?.reason, PI_BACKGROUND_JOB_TOOL_NAME);
      }
      for (const command of [
        "build && test",
        "build |& cat",
        "build |& cat && test",
        "build # comment with & nohup setsid disown",
        "# nohup test &\nbuild",
        "build;# setsid test &\ntest",
        "echo word#value",
        "echo \\#value",

        "echo '&'",
        'echo "&"',
        "echo nohup",
        "echo disown",
        "printf 'setsid &'; build",
        "build 2>&1",
        "build &>output",
        "echo \\&",
        "echo 'don\"t &'",
      ]) {
        assert.isUndefined(await hook({ toolName: "bash", input: { command } }, ctx), command);
      }
    });
  }
});
