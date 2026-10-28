const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

/** Reserve expansion height because the timeline does not move when footer growth covers its last rows. */
export function resolveComposerTimelineInset(input: {
  currentInset: number;
  overlayHeight: number;
  isResting: boolean;
  restingOnlyHeight?: number;
}): number {
  const overlayHeight = Math.ceil(input.overlayHeight);
  return input.isResting
    ? Math.max(
        input.currentInset,
        overlayHeight +
          (input.currentInset === 0
            ? COMPOSER_RESTING_EXPANSION_MIN_PX - (input.restingOnlyHeight ?? 0)
            : 0),
      )
    : overlayHeight;
}

export function overlayComposerIsResting(input: {
  composerMounted: boolean;
  composerReportedResting: boolean;
}): boolean {
  return input.composerMounted && input.composerReportedResting;
}

