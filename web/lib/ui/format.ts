/** "24 Oct 2026, 22:00" in the organization's time zone. */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

const BATTERY_EMPTY_MV = 3300;
const BATTERY_FULL_MV = 4200;

/** Linear estimate (decision D3) until the hardware team gives a discharge curve. */
export function batteryPercent(mv: number): number {
  const percent =
    ((mv - BATTERY_EMPTY_MV) / (BATTERY_FULL_MV - BATTERY_EMPTY_MV)) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

/** Directions to a tree, for a field worker's phone. */
export function directionsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}
