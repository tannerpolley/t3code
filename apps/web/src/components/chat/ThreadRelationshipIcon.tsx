import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * Lineage rows' leading glyph: the agent's provider, or the relationship's icon. `status` adds the
 * original corner badge, for when the Lineage redesign (which shows a status mark instead) is off.
 */
export function ThreadRelationshipIcon({
  driver,
  provider,
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  status?: string | null | undefined;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          acpRegistryIconUrl={provider?.iconUrl}
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      {status === undefined ? null : (
        <span
          className={cn(
            "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
            status === "running" ||
              status === "in_progress" ||
              status === "pending" ||
              status === "waiting"
              ? "bg-info"
              : status === "failed" || status === "error"
                ? "bg-destructive"
                : status === "completed"
                  ? "bg-success"
                  : "bg-muted-foreground/45",
          )}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
