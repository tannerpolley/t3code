import { useGT } from "gt-react";
import { ForkSettingsRow as SettingsRow } from "./ForkSettingsRow";
import { INTERFACE_ZOOM_FACTORS, nearestInterfaceZoom } from "@t3tools/shared/interfaceZoom";
import { useEffect, useState } from "react";

import { isMacPlatform } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSearchableSetting } from "./settingsSearch";

const percent = (factor: number) => `${Math.round(factor * 100)}%`;

/**
 * Settings → Appearance → Interface zoom. Desktop only: the browser already
 * zooms web clients. The window's zoom level is the one value; the keyboard
 * shortcuts change it too, which shows up here as a window resize.
 */
export function InterfaceZoomSettingsRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.interfaceZoom;
  const [factor, setFactor] = useState<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the desktop shell's zoom factor and follows window resizes, which the bridge does not push.
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const read = () =>
      void bridge
        .get()
        .then((next) => {
          if (!cancelled) setFactor(nearestInterfaceZoom(next));
        })
        .catch(() => undefined);
    read();
    window.addEventListener("resize", read);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", read);
    };
  }, [bridge]);

  if (!bridge || factor === null) return null;
  const mod = isMacPlatform(navigator.platform) ? "Cmd" : "Ctrl";
  return (
    <SettingsRow
      {...searchableSetting("interface-zoom")}
      description={gt(
        "Make everything larger or smaller. {mod}+= and {mod}+- change it, {mod}+0 resets it.",
        { mod },
      )}
      control={
        <Select
          value={String(factor)}
          onValueChange={(value) => {
            const next = Number(value);
            setFactor(next);
            void bridge.set(next).catch(() => undefined);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-28" aria-label={gt("Interface zoom")}>
            <SelectValue>{percent(factor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {INTERFACE_ZOOM_FACTORS.map((step) => (
              <SelectItem hideIndicator key={step} value={String(step)}>
                {percent(step)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
