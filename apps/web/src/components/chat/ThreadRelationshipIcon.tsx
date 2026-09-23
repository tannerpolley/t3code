import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Lineage rows' leading glyph: the agent's provider, or the relationship's icon. */
export function ThreadRelationshipIcon({
  driver,
  provider,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
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
    </span>
  );
}
