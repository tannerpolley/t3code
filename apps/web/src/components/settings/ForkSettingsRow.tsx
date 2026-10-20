import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { SettingsRow } from "./settingsLayout";

const ForkSettingsMirrorContext = createContext(false);

/** Search anchors belong to the normal tab, even when its rows are also gathered here. */
export function ForkSettingsMirror({ children }: { readonly children: ReactNode }) {
  return <ForkSettingsMirrorContext value={true}>{children}</ForkSettingsMirrorContext>;
}

export function ForkSettingsTag() {
  return (
    <Badge variant="outline" size="sm">
      Fork
    </Badge>
  );
}

/** Keep the fork marker with its setting title, including scoped and resettable rows. */
export function ForkSettingsRow({ title, ...props }: ComponentProps<typeof SettingsRow>) {
  const mirror = useContext(ForkSettingsMirrorContext);
  return (
    <SettingsRow
      {...props}
      id={mirror ? undefined : props.id}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {title}
          <ForkSettingsTag />
        </span>
      }
    />
  );
}
