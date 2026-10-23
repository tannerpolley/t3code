import { useEffect, useEffectEvent } from "react";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usage/usagePagePreferences";

const OPEN_RESET_CREDIT_USAGE = "t3:open-reset-credit-usage";

export function prepareResetCreditUsage(): void {
  saveUsagePagePreferences({
    ...readUsagePagePreferences(),
    metric: "limits",
    hiddenProviders: [],
  });
  window.dispatchEvent(new Event(OPEN_RESET_CREDIT_USAGE));
}

export function useResetCreditUsageNavigation(open: () => void): void {
  const onOpen = useEffectEvent(open);
  useEffect(() => {
    const listener = () => onOpen();
    window.addEventListener(OPEN_RESET_CREDIT_USAGE, listener);
    return () => window.removeEventListener(OPEN_RESET_CREDIT_USAGE, listener);
  }, []);
}
