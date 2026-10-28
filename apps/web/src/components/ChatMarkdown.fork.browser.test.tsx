const inlineMocks = vi.hoisted(() => ({
  run: vi.fn(),
  write: vi.fn(),
  listeners: new Set<() => void>(),
  output: null as
    | typeof import("@t3tools/client-runtime/state/inlineShell").emptyInlineShellOutput
    | null,
}));
vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: unknown) =>
      atom === "inline-permission" ? true : actual.useAtomValue(atom as never)) as never,
  };
});
vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    runInline: { permissionAtom: () => "inline-permission" },
    write: { permissionAtom: () => "inline-permission" },
    watchInlineRun: () => "inline-record",
    observeInline: () => "inline-output",
  },
}));
vi.mock(import("../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: unknown) => {
      const data = useSyncExternalStore(
        (notify) => {
          inlineMocks.listeners.add(notify);
          return () => {
            inlineMocks.listeners.delete(notify);
          };
        },
        () => (atom === "inline-output" ? inlineMocks.output : null),
      );
      return { data, error: null };
    }) as never,
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown) => {
      if (command === terminalEnvironment.runInline) return inlineMocks.run;
      if (command === terminalEnvironment.write) return inlineMocks.write;
      return actual.useAtomCommand(command as never);
    }) as never,
  };
});
import { terminalEnvironment } from "../state/terminal";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { AsyncResult } from "effect/reactivity";

import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// A standard client session, so environment-owned file links can open.
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../state/environments"), () => ({
  readPrimaryEnvironmentId: () => null,
  useEnvironments: (() => ({
    isReady: false,
    networkStatus: null,
    environments: [],
    presentationById: new Map(),
  })) as never,
  useEnvironmentProviders: (() => new Map()) as never,
  usePrimaryEnvironmentId: (() => null) as never,
  useEnvironment: (() => null) as never,
  usePrimaryEnvironment: (() => null) as never,
  useEnvironmentHttpBaseUrl: (() => null) as never,
  useRelayEnvironmentDiscovery: (() => ({})) as never,
  useEnvironmentIds: (() => []) as never,
  useEnvironmentIdentities: (() => []) as never,
  usePullRequestsSupported: (() => false) as never,
  useIssuesSupported: (() => false) as never,
  useEnvironmentMachines: (() => new Map()) as never,
  useConnectedEnvironmentIds: (() => []) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { InlineShellRunProvider } from "./chat/InlineShellRun";
import { emptyInlineShellOutput } from "@t3tools/client-runtime/state/inlineShell";

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

function fileOptions(container: HTMLElement) {
  return [...container.querySelectorAll("button")]
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label?.startsWith("File options for "));
}

describe("ChatMarkdown streaming", () => {
  it("runs closed shell blocks inline and through the terminal command action", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const onOpenInlineTerminal = vi.fn();
    const environmentId = EnvironmentId.make("inline-environment");
    const threadId = ThreadId.make("inline-thread");
    inlineMocks.run.mockReset().mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: {
        ...input,
        terminalId: `inline-${input.runId}`,
        sequence: inlineMocks.run.mock.calls.length,
        status: "running",
        startedAt: "2026-10-13T00:00:00.000Z",
        completedAt: null,
        durationMs: 0,
        output: "",
        exitCode: null,
        error: null,
      },
    }));
    using _outputReset = {
      [Symbol.dispose]() {
        inlineMocks.output = null;
      },
    };
    const message = (text: string, isStreaming = false) => (
      <InlineShellRunProvider key={text} environmentId={environmentId} threadId={threadId}>
        <ChatMarkdown
          cwd="/tmp/project"
          text={text}
          isStreaming={isStreaming}
          shellMessageId="visible-message"
          onRunShellCommand={onRunShellCommand}
          onOpenInlineTerminal={onOpenInlineTerminal}
        />
      </InlineShellRunProvider>
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const inlineButtons = () => buttonsLabelled(container, "Run inline");
    const terminalButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(inlineButtons()).toHaveLength(0);
    expect(terminalButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => terminalButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");
    onRunShellCommand.mockClear();

    for (const [fence, command, terminalEnabled] of [
      ["```bash\necho hello\n```", "echo hello", true],
      ["~~~bash\necho tilde\n~~~", "echo tilde", true],
      ["> ```bash\n> echo quote\n> ```", "echo quote", true],
      ["````bash\necho four\n````", "echo four", true],
      ["```bash\necho one\necho two\n```", "echo one\necho two", false],
      ["```bash\necho trailing\n\n```", "echo trailing", false],
    ] as const) {
      inlineMocks.output = { ...emptyInlineShellOutput, status: "running" };
      await rerender(message(fence!));
      expect(inlineButtons()).toHaveLength(1);
      expect(terminalButtons()).toHaveLength(terminalEnabled ? 1 : 0);
      await act(async () => inlineButtons()[0]!.click());
      expect(inlineMocks.run.mock.calls.at(-1)?.[0]).toMatchObject({
        environmentId,
        input: {
          threadId,
          blockId: expect.stringContaining("visible-message:"),
          command,
          language: "bash",
        },
      });
      inlineMocks.output = {
        ...emptyInlineShellOutput,
        status: "exited",
        output: "done",
        exitCode: 7,
        endedAt: Date.parse("2026-10-13T00:00:02Z"),
      };
      await act(async () => inlineMocks.listeners.forEach((notify) => notify()));
      expect(
        [...container.querySelectorAll("button")].some((button) => button.textContent === "Stop"),
      ).toBe(false);
      expect([...container.querySelectorAll("pre")].some((pre) => pre.textContent === "done")).toBe(
        true,
      );
    }
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in terminal",
    );
    await act(async () => open!.click());
    expect(onOpenInlineTerminal).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^inline-/));
    expect(inlineMocks.run).toHaveBeenCalledTimes(6);

    for (const text of [
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(inlineButtons()).toHaveLength(0);
      expect(terminalButtons()).toHaveLength(0);
    }
  });
});

describe("ChatMarkdown file citations", () => {
  it.each([
    ':codex-file-citation{purpose="output"}',
    ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}',
  ])("leaves %s literal", async (text) => {
    setup();
    await using screen = await renderText(text);
    const { container } = screen;
    expect(container.textContent).toContain(text.replace("\\", ""));
    expect(fileOptions(container)).toEqual([]);
  });
});

describe("ChatMarkdown inline code copying", () => {
  it("copies inline code on click and Enter", async () => {
    setup();
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await using screen = await renderText("Run `vp test run` now.");
    const code = screen.container.querySelector("code")!;

    await act(async () => code.click());
    await act(async () => {
      code.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(writeText.mock.calls).toEqual([["vp test run"], ["vp test run"]]);
  });
});

describe("ChatMarkdown provider math delimiters", () => {
  it.each([true, false])(
    "renders \\( \\) and \\[ \\] as math only with Render math on: %s",
    async (on) => {
      setup();
      settingsOverrides.mathRenderingEnabled = on;
      await using screen = await renderText("Inline \\(x^2\\) here.\n\n\\[\n\\sum_i a_i\n\\]");
      const { container } = screen;
      await act(async () => {
        await import("./chat/MathTypeset");
      });
      expect(
        [...container.querySelectorAll("[data-markdown-math]")].map((node) =>
          node.getAttribute("data-markdown-math"),
        ),
      ).toEqual(on ? ["inline", "display"] : []);
      expect(container.querySelectorAll(".katex").length).toBe(on ? 2 : 0);
      if (!on) expect(container.textContent).toContain("(x^2)");
    },
  );
});
