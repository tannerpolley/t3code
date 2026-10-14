/** The usage cell: a thread's whole-percent share of its weekly limit, shown from 1%. */
export function formatWeeklyLimitPercent(percent: number | undefined): string | null {
  return percent !== undefined && percent >= 1 ? `${Math.floor(percent)}%` : null;
}
