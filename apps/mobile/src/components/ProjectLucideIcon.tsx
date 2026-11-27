import type { ProjectIconOverride } from "@t3tools/contracts";
import * as Lucide from "lucide-react-native";
import type { ReactNode } from "react";
import { useResolveClassNames } from "uniwind";

import { projectIconColorClassNames } from "../lib/projectIcon";

const lucideExports: Readonly<Record<string, unknown>> = Lucide;

export default function ProjectLucideIcon(props: {
  readonly icon: Extract<ProjectIconOverride, { kind: "lucide" }>;
  readonly open?: boolean;
  readonly size: number;
  readonly fallback: ReactNode;
}) {
  const { color } = useResolveClassNames(projectIconColorClassNames(props.icon.color).text);
  const iconName = props.open && props.icon.name === "folder" ? "folder-open" : props.icon.name;
  const name = iconName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const resolved = lucideExports[`${name}Icon`];
  if (!resolved) return props.fallback;
  const Icon = resolved as Lucide.LucideIcon;
  return <Icon size={props.size} color={typeof color === "string" ? color : undefined} />;
}
