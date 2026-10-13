import {
  ROUTED_REQUEST_ALERT_SETTLE_MS,
  runtimeRequestOwnerAlertIsSettled,
} from "@t3tools/shared/delegatedRequestVisibility";
import { useEffect, useRef, useState } from "react";
import type { PendingQuestion } from "./QuestionPopup.logic";

/** The collection already derives visibility; only opening the popup waits for settlement. */
export function useSettledQuestions(questions: ReadonlyArray<PendingQuestion>) {
  const visibleSince = useRef(new Map<string, number>());
  const [settledKeys, setSettledKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const now = Date.now();
    const next = new Map(
      questions.map((question) => [question.key, visibleSince.current.get(question.key) ?? now]),
    );
    visibleSince.current = next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = Date.now();
      const keys = new Set<string>();
      let delay = Infinity;
      for (const question of questions) {
        const since = next.get(question.key)!;
        if (runtimeRequestOwnerAlertIsSettled(question, since, now)) keys.add(question.key);
        else delay = Math.min(delay, ROUTED_REQUEST_ALERT_SETTLE_MS - (now - since));
      }
      setSettledKeys((prior) =>
        prior.size === keys.size && [...keys].every((key) => prior.has(key)) ? prior : keys,
      );
      if (delay !== Infinity) timer = setTimeout(update, delay);
    };
    update();
    return () => clearTimeout(timer);
  }, [questions]);
  return questions.filter(
    (question) => question.routedTo === undefined || settledKeys.has(question.key),
  );
}
