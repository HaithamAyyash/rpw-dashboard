export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** All dashboard data comes through here. A lost session goes back to the login page. */
export async function apiGet<T>(
  path: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "")
      search.set(key, String(value));
  }
  const query = search.toString();
  const response = await fetch(`/api/v1${path}${query ? `?${query}` : ""}`);
  if (response.status === 401) {
    // A full page load on purpose: it drops anything cached from the previous session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
    throw new ApiError(401, "Session ended");
  }
  if (!response.ok)
    throw new ApiError(response.status, `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export type Status = "healthy" | "suspected" | "alert" | "offline" | "unknown";

export type Summary = {
  trees_monitored: number;
  healthy: number;
  suspected: number;
  alerts: number;
  offline: number;
  unknown: number;
  active_nodes: number;
  total_nodes: number;
  measurements_last_hour: number;
  suspected_yesterday: number;
  suspected_change: number;
  with_heartbeat: number;
};

export type Tree = {
  node_id: number;
  lora_id: number;
  tree_label: string;
  farm_zone: string | null;
  cluster_id: string;
  status: Status;
  avg_confidence: number | null;
  last_runs: number[] | null;
  last_measurement: string | null;
  measurements_24h: number;
  battery_mv: number | null;
  rssi_dbm: number | null;
  location_lat: number | null;
  location_lon: number | null;
};

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};

export type OrgSettings = {
  org_id: string;
  name: string;
  slug: string;
  timezone: string;
  suspect_threshold: number;
  alert_threshold: number;
};
