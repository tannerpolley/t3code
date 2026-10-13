import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { sidebarUsageProvidersToRefresh, refreshSidebarUsage } from "./forkUsageRefresh";

/** Event-driven catch-up for the sidebar, including reconnects; no additional timer. */
export function useForkUsageRefresh() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const pending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const connected = [...presentations]
    .filter(([, presentation]) => presentation.connection.phase === "connected")
    .map(([id]) => id)
    .sort()
    .join(",");
  const refresh = useCallback(
    async (automatic = false) => {
      if (pending.current) return;
      pending.current = true;
      setRefreshing(true);
      setFailed(false);
      try {
        const results = await Promise.all(
          [...presentations].map(([environmentId, presentation]) => {
            if (presentation.connection.phase !== "connected" || !presentation.serverConfig) return;
            const providers = sidebarUsageProvidersToRefresh(
              presentation.serverConfig.providers,
              Date.now(),
              automatic,
            );
            if (providers.length === 0) return;
            return refreshSidebarUsage(
              environmentId,
              () =>
                Promise.all(
                  automatic
                    ? providers.map(({ instanceId }) =>
                        refreshProviders({ environmentId, input: { instanceId } }),
                      )
                    : [refreshProviders({ environmentId, input: {} })],
                ),
              automatic,
            );
          }),
        );
        setFailed(results.flat().some((result) => result?._tag === "Failure"));
      } catch {
        setFailed(true);
      } finally {
        pending.current = false;
        setRefreshing(false);
      }
    },
    [presentations, refreshProviders],
  );
  const catchUp = useEffectEvent(() => {
    if (document.visibilityState === "visible") void refresh(true);
  });
  useEffect(() => {
    // Defer the connection catch-up to avoid updating React state during the effect itself.
    let active = true;
    void Promise.resolve().then(() => {
      if (active && connected) catchUp();
    });
    return () => {
      active = false;
    };
  }, [connected]);
  useEffect(() => {
    const listener = () => catchUp();
    window.addEventListener("focus", listener);
    document.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener("focus", listener);
      document.removeEventListener("visibilitychange", listener);
    };
  }, []);
  return { refresh, refreshing, failed };
}
