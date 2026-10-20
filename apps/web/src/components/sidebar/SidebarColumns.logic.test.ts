import { expect, it } from "vite-plus/test";
import { sidebarCaretCount } from "./SidebarColumns.logic";

it("shows a bounded count only while work is closed", () => {
  expect(sidebarCaretCount(undefined, false)).toBeUndefined();
  expect(sidebarCaretCount(0, false)).toBeUndefined();
  expect(sidebarCaretCount(1, false)).toBe("1");
  expect(sidebarCaretCount(16, false)).toBe("16");
  expect(sidebarCaretCount(99, false)).toBe("99");
  expect(sidebarCaretCount(100, false)).toBe("99+");
  expect(sidebarCaretCount(1000, true)).toBeUndefined();
  expect(sidebarCaretCount(16)).toBe("16");
});
