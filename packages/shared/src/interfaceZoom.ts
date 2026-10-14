/**
 * Desktop interface zoom steps. The Settings dropdown and the Ctrl/Cmd +, -, 0
 * shortcuts both walk this one list, so they always agree on the value.
 */
export const INTERFACE_ZOOM_FACTORS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** Chromium's zoom level is the base-1.2 logarithm of the zoom factor. */
export const zoomFactorToLevel = (factor: number): number => Math.log(factor) / Math.log(1.2);
export const zoomLevelToFactor = (level: number): number => 1.2 ** level;

/** The listed step closest to `factor`. */
export const nearestInterfaceZoom = (factor: number): number =>
  INTERFACE_ZOOM_FACTORS.reduce((best, step) =>
    Math.abs(step - factor) < Math.abs(best - factor) ? step : best,
  );

/** One step up or down from `factor`, stopping at the ends of the list. */
export const stepInterfaceZoom = (factor: number, direction: "in" | "out"): number => {
  const epsilon = 0.001;
  const steps = INTERFACE_ZOOM_FACTORS;
  return direction === "in"
    ? (steps.find((step) => step > factor + epsilon) ?? steps[steps.length - 1]!)
    : (steps.findLast((step) => step < factor - epsilon) ?? steps[0]!);
};
