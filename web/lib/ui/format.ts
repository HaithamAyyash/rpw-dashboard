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

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Four signal bars from dBm, for LoRa's usual range. */
export function signalBars(dbm: number): number {
  if (dbm >= -85) return 4;
  if (dbm >= -95) return 3;
  if (dbm >= -105) return 2;
  if (dbm >= -115) return 1;
  return 0;
}

export function batteryClass(percentage: number): {
  text: string;
  bar: string;
} {
  if (percentage > 50) return { text: "text-accent", bar: "bg-accent" };
  if (percentage > 25) return { text: "text-warn", bar: "bg-warn" };
  return { text: "text-danger", bar: "bg-danger" };
}

/** An <input type="date"> value, as the start of that day in UTC. */
export function dayStart(date: string): string {
  return `${date}T00:00:00Z`;
}

export function dayEnd(date: string): string {
  return `${date}T23:59:59Z`;
}
