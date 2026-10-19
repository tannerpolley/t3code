// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useUiStateStore } from "../../uiStateStore";
import { useSidebarWorkExpansion } from "./useSidebarWorkExpansion";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStateStore.setState({ sidebarWorkExpandedById: {} });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  useUiStateStore.setState({ sidebarWorkExpandedById: {} });
  vi.unstubAllGlobals();
});
function Row(props: { threadKey: string; running: boolean }) {
  const { open, onToggle } = useSidebarWorkExpansion(props.threadKey, props.running);
  return (
    <button aria-expanded={open} onClick={onToggle}>
      {props.threadKey}
    </button>
  );
}

it("retains scoped expansion choices when an agent leaves the roster and returns", async () => {
  const render = (showB: boolean, running = true, environment = "local") =>
    act(() =>
      root.render(
        <>
          {showB ? <Row key="b" threadKey={`${environment}:b`} running={running} /> : null}
          <Row key="c" threadKey="local:c" running />
        </>,
      ),
    );
  const b = () => container.querySelector("button")!;
  await render(true);
  expect(b().getAttribute("aria-expanded")).toBe("true");
  await act(() => b().click());
  await render(false);
  await render(true);
  expect(b().getAttribute("aria-expanded")).toBe("false");
  await render(true, true, "remote");
  expect(b().getAttribute("aria-expanded")).toBe("true");
  await render(true, false);
  await act(() => b().click());
  await render(false);
  await render(true, false);
  expect(b().getAttribute("aria-expanded")).toBe("true");
});

it("bounds memory-only expansion choices by evicting the oldest choice", () => {
  useUiStateStore.setState({
    sidebarWorkExpandedById: Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`local:${i}`, false]),
    ),
  });
  const { setSidebarWorkExpanded } = useUiStateStore.getState();
  setSidebarWorkExpanded("local:0", true);
  setSidebarWorkExpanded("remote:new", false);
  const choices = useUiStateStore.getState().sidebarWorkExpandedById;
  expect(Object.keys(choices)).toHaveLength(2000);
  expect(choices["local:0"]).toBe(true);
  expect(choices["local:1"]).toBeUndefined();
  expect(choices["remote:new"]).toBe(false);
});
