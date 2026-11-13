import * as Context from "effect/Context";
import * as Tracer from "effect/Tracer";

// Shorter spans cannot have lasted through a reported stall (EventLoopMonitor's threshold).
const LONG_SPAN_NS = 2_000_000_000n;
const RECENT_SPANS = 64;
const REPORTED_SPANS = 5;

export interface SpanActivity {
  readonly name: string;
  readonly startNs: bigint;
  /** Undefined while the span is still open. */
  readonly endNs?: bigint | undefined;
}

/**
 * Spans that lasted at least the whole stall and overlap the window it fell in, latest start
 * first. Blocking work starts no earlier than its enclosing spans, so the culprit or its
 * innermost span leads; spans that merely waited through the stall can follow it.
 */
export const stallSuspects = (
  spans: Iterable<SpanActivity>,
  stall: { readonly stallMs: number; readonly windowMs: number; readonly nowNs: bigint },
): ReadonlyArray<string> => {
  const stallNs = BigInt(Math.round(stall.stallMs * 1e6));
  const windowStartNs = stall.nowNs - BigInt(Math.round(stall.windowMs * 1e6));
  return [...spans]
    .filter(
      ({ startNs, endNs = stall.nowNs }) => endNs - startNs >= stallNs && endNs >= windowStartNs,
    )
    .toSorted((left, right) => (left.startNs > right.startNs ? -1 : 1))
    .slice(0, REPORTED_SPANS)
    .map(
      ({ name, startNs, endNs }) =>
        `${name} ${(Number((endNs ?? stall.nowNs) - startNs) / 1e9).toFixed(1)} s${endNs === undefined ? " (open)" : ""}`,
    );
};

export class StallAttribution extends Context.Reference<{
  readonly suspects: (stall: {
    readonly stallMs: number;
    readonly windowMs: number;
    readonly nowNs: bigint;
  }) => ReadonlyArray<string>;
}>("t3/observability/StallAttribution", {
  defaultValue: () => ({ suspects: () => [] }),
}) {}

/** Wraps a tracer to remember open spans and recently ended long ones for stall records. */
export const make = (tracer: Tracer.Tracer) => {
  const open = new Map<Tracer.Span, SpanActivity>();
  const recent: Array<SpanActivity> = [];
  const wrapped = Tracer.make({
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
    span(options) {
      const span = tracer.span(options);
      const activity = { name: options.name, startNs: options.startTime };
      open.set(span, activity);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        open.delete(span);
        if (endTime - activity.startNs >= LONG_SPAN_NS) {
          recent.push({ ...activity, endNs: endTime });
          if (recent.length > RECENT_SPANS) recent.shift();
        }
        end(endTime, exit);
      };
      return span;
    },
  });
  return {
    tracer: wrapped,
    attribution: StallAttribution.of({
      suspects: (stall) => stallSuspects([...open.values(), ...recent], stall),
    }),
  };
};
