import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
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
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    ...bindings,
    process: { env },
    pi: {
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
  for (const discovery of ["inactive", "active", "missing", "hidden"] as const) {
    it(`registers callable T3 tools with ${discovery} tool_search`, async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const registered = new Map<
        string,
        {
          name: string;
          exposure?: string;
          promptGuidelines?: string[];
          execute: (id: string, params: unknown, signal: AbortSignal) => Promise<{
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
              return discovery === "missing" ? [] : [{ name: "tool_search" }];
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
      assert.equal(registered.size, discovery === "inactive" ? 0 : 1);
      if (discovery !== "inactive") {
        assert.equal(registered.get("mcp__t3-code__orchestrator_capabilities")?.exposure, "deferred");
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
      assert.equal(registered.size, 1);
      const tool = registered.get("mcp__t3-code__orchestrator_capabilities")!;
      const deferred = discovery === "active" || discovery === "inactive";
      assert.equal(tool.name, "mcp__t3-code__orchestrator_capabilities");
      assert.equal(tool.exposure, deferred ? "deferred" : undefined);
      assert.isUndefined(tool.promptGuidelines);
      assert.deepEqual(active, deferred ? ["read", "tool_search"] : ["read"]);
      const beforeStart = hooks.get("before_agent_start") as unknown as (
        event: { systemPrompt: string },
      ) => { systemPrompt: string };
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
    assert.isTrue(
      (await hook({ toolName: "mcp__t3-code__delegate_task", input: {} }, ctx))?.block,
    );
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
