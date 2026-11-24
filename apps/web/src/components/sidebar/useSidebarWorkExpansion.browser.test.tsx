import { act, render } from "../../../test/render";
import { expect, it } from "vite-plus/test";
import { useUiStateStore } from "../../uiStateStore";
import { useSidebarWorkExpansion } from "./useSidebarWorkExpansion";

function Row(props: { threadKey: string; running: boolean }) {
  const { open, onToggle } = useSidebarWorkExpansion(props.threadKey, props.running);
  return (
    <button aria-expanded={open} onClick={onToggle}>
      {props.threadKey}
    </button>
  );
}

it("retains scoped expansion choices when an agent leaves the roster and returns", async () => {
  useUiStateStore.setState({ sidebarWorkExpandedById: {} });
  const rows = (showB: boolean, running = true, environment = "local") => (
    <>
      {showB ? <Row key="b" threadKey={`${environment}:b`} running={running} /> : null}
      <Row key="c" threadKey="local:c" running />
    </>
  );
  await using screen = await render(rows(true));
  const b = () => screen.container.querySelector("button")!;
  expect(b().getAttribute("aria-expanded")).toBe("true");
  await act(() => b().click());
  await screen.rerender(rows(false));
  await screen.rerender(rows(true));
  expect(b().getAttribute("aria-expanded")).toBe("false");
  await screen.rerender(rows(true, true, "remote"));
  expect(b().getAttribute("aria-expanded")).toBe("true");
  await screen.rerender(rows(true, false));
  await act(() => b().click());
  await screen.rerender(rows(false));
  await screen.rerender(rows(true, false));
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
