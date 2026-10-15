import type { ComponentProps } from "react";
import { Badge } from "../ui/badge";
import { SettingsRow } from "./settingsLayout";

export function ForkSettingsTag() {
  return (
    <Badge variant="outline" size="sm">
      Fork
    </Badge>
  );
}

/** Keep the fork marker with its setting title, including scoped and resettable rows. */
export function ForkSettingsRow({ title, ...props }: ComponentProps<typeof SettingsRow>) {
  return (
    <SettingsRow
      {...props}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {title}
          <ForkSettingsTag />
        </span>
      }
    />
  );
}
