import type { Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastTarget: null as unknown,
  iconFallback: "folder" as "folder" | "initials",
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.faviconUrl,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: { projectIconFallback: string }) => T) =>
    select({ projectIconFallback: testState.iconFallback }),
}));
vi.mock("../state/assets", () => ({
  projectFaviconUrlAtom: (input: unknown) => {
    testState.lastTarget = input;
  },
}));

import { FolderIcon } from "lucide-react";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

function makeProject(
  overrides: Partial<ProjectFaviconProject> &
    Pick<ProjectFaviconProject, "workspaceRoot" | "title">,
): ProjectFaviconProject {
  return { environmentId: "environment-test" as EnvironmentId, ...overrides };
}

type FallbackElement = ReactElement<{
  readonly projectName?: string;
  readonly icon: unknown;
  readonly className?: string;
}>;

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
    testState.iconFallback = "folder";
  });

  it("shows the default folder with its section color when no favicon exists", () => {
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;

    const element = ProjectFavicon({
      project: makeProject({ workspaceRoot: "/workspace/analytics-db", title: "analytics-db" }),
      folderColor: "blue",
    }) as FallbackElement;

    expect(element.props.icon).toBe(FolderIcon);
    expect(element.props.projectName).toBeUndefined();
    expect(element.props.className).toContain("text-blue-600");
  });

  it("lets a section folder override a custom icon and favicon", () => {
    testState.iconFallback = "initials";
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;

    const element = ProjectFavicon({
      project: makeProject({
        workspaceRoot: "/workspace/agent-runtime",
        title: "agent-runtime",
        projectIcon: { kind: "lucide", name: "folder-code", color: "yellow" },
      }),
      folderColor: "red",
      forceFolder: true,
    }) as FallbackElement;

    expect(element.props.icon).toBe(FolderIcon);
    expect(element.props.className).toContain("text-red-600");
  });

  it("shows the selected folder icon color and opens it for an expanded project", () => {
    const project = makeProject({
      workspaceRoot: "/workspace/agent-runtime",
      title: "agent-runtime",
      projectIcon: { kind: "folder", color: "teal" },
    });
    const closed = ProjectFavicon({ project }) as FallbackElement;
    const OpenIcon = () => null;
    const open = ProjectFavicon({ project, fallbackIcon: OpenIcon }) as FallbackElement;

    expect(closed.props.icon).toBe(FolderIcon);
    expect(closed.props.className).toContain("text-teal-600");
    expect(open.props.icon).toBe(OpenIcon);
  });

  it("uses project initials only when the user selects that fallback", () => {
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;
    testState.iconFallback = "initials";

    const element = ProjectFavicon({
      project: makeProject({ workspaceRoot: "/workspace/analytics-db", title: "analytics-db" }),
    }) as FallbackElement;

    expect(element.props.projectName).toBe("analytics-db");
  });
});
