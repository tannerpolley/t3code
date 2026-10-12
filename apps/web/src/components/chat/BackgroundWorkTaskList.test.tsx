import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import type * as Atom from "effect/reactivity/Atom";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  active: new Set<string>(),
  outputAtoms: new Map<string, Atom.Writable<string>>(),
  processOutput: true,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: { backgroundProcessOutput: boolean }) => T) =>
    select({ backgroundProcessOutput: state.processOutput }),
}));
vi.mock("../../state/orchestration", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const streams = Atom.family((key: string) => {
    const output = Atom.make("first line\n");
    state.outputAtoms.set(key, output);
    return Atom.make((get) => {
      state.active.add(key);
      get.addFinalizer(() => state.active.delete(key));
      return AsyncResult.success(get(output));
    }).pipe(Atom.setIdleTTL(0));
  });
  return {
    orchestrationEnvironment: {
      stopBackgroundTask: {},
      backgroundTaskOutput: ({
        environmentId,
        input,
      }: {
        environmentId: string;
        input: { threadId: string; taskId: string };
      }) => streams(`${environmentId}:${input.threadId}:${input.taskId}`),
    },
  };
});
// Only output leases are under test; no usage scan or sidebar child subscription is needed.
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../sidebar/SidebarBackgroundWorkRows", () => ({ SidebarBackgroundWorkRows: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: (props: React.ComponentProps<"button">) => <button {...props} />,
  PopoverPopup: () => null,
}));

import { BackgroundWorkTaskList } from "./BackgroundWorkTaskList";

let renderer: ReactTestRenderer | undefined;
const registry = AtomRegistry.make();

afterEach(async () => {
  await act(async () => renderer?.unmount());
  registry.reset();
  state.active.clear();
  state.processOutput = true;
  vi.unstubAllGlobals();
});

it("streams only expanded task output and releases it on collapse, task removal and panel close", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("remote");
  const threadId = ThreadId.make("parent");
  const rows = [
    { taskId: "codex", kind: "command" as const, label: "Run tests", startedAt: null },
    {
      taskId: "claude",
      kind: "monitor" as const,
      ownerThreadId: ThreadId.make("child"),
      label: "Watch logs",
      startedAt: null,
    },
    { taskId: "other", kind: "background_task" as const, label: "Other work", startedAt: null },
  ];
  const panel = (visibleRows = rows) => (
    <RegistryContext.Provider value={registry}>
      <BackgroundWorkTaskList
        environmentId={environmentId}
        threadId={threadId}
        rows={visibleRows}
      />
    </RegistryContext.Provider>
  );
  await act(async () => {
    renderer = create(panel());
  });
  const mounted = renderer!;
  const click = async (label: string) => {
    await act(async () => {
      mounted.root
        .findAll((node) => node.type === "button" && node.props["aria-label"] === label)[0]!
        .props.onClick();
    });
  };
  expect([...state.active]).toEqual([]);

  await click("Show output for Run tests");
  expect([...state.active]).toEqual(["remote:parent:codex"]);
  expect(mounted.root.findByType("pre").children).toEqual(["first line\n"]);
  await act(async () => {
    registry.set(state.outputAtoms.get("remote:parent:codex")!, "first line\nnew output\n");
  });
  expect(mounted.root.findByType("pre").children).toEqual(["first line\nnew output\n"]);

  await click("Hide output for Run tests");
  expect([...state.active]).toEqual([]);
  await click("Show output for Watch logs");
  expect([...state.active]).toEqual(["remote:child:claude"]);
  await act(async () => mounted.update(panel(rows.filter((row) => row.taskId !== "claude"))));
  expect([...state.active]).toEqual([]);

  await click("Show output for Run tests");
  expect([...state.active]).toEqual(["remote:parent:codex"]);
  state.processOutput = false;
  await act(async () => mounted.update(panel(rows.filter((row) => row.taskId !== "claude"))));
  expect([...state.active]).toEqual([]);
  state.processOutput = true;
  await act(async () => mounted.update(panel()));
  await click("Show output for Run tests");
  expect([...state.active]).toEqual(["remote:parent:codex"]);
  await act(async () => mounted.update(<RegistryContext.Provider value={registry} />));
  expect([...state.active]).toEqual([]);
});
