export type ErrorDetail = { path?: string; line?: number; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
  }
}

/** Writes. The message comes from the server, so forms can show exactly what was wrong. */
export async function apiSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      json?.error?.message ?? `Request failed (${response.status})`,
      json?.error?.code,
      json?.error?.details,
    );
  }
  return json as T;
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

export type MorePage<T> = {
  items: T[];
  has_more: boolean;
  page: number;
  page_size: number;
};

export type Alert = {
  alert_id: number;
  timestamp: string;
  alert_type: string;
  severity: "critical" | "warning" | "info";
  confidence: number | null;
  message: string;
  node_id: number | null;
  tree_label: string | null;
  cluster_name: string | null;
  acknowledged: boolean;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  email_sent_at: string | null;
};

export type Classification = {
  node_id: number;
  lora_id: number;
  tree_label: string;
  timestamp: string;
  model_version: string;
  label: string;
  confidence: number;
  status?: Status;
};

export type FeatureRecord = {
  node_id: number;
  lora_id: number;
  tree_label: string;
  timestamp: string;
  energy: number | null;
  snr_db: number | null;
  rssi_dbm: number | null;
  status: string;
  label: string | null;
  confidence: number | null;
  model_version: string | null;
};

export type NodeHealth = {
  node_id: number;
  lora_id: number;
  tree_label: string;
  farm_zone: string | null;
  status: Status;
  battery_mv: number | null;
  rssi_dbm: number | null;
  uptime_s: number | null;
  last_heartbeat: string | null;
  last_classified: string | null;
};

export type ClusterHealth = {
  cluster_id: string;
  name: string;
  farm_zone: string | null;
  uplink_type: string | null;
  revoked: boolean;
  last_seen: string | null;
  uptime_s: number | null;
  rssi_dbm: number | null;
  sd_free_mb: number | null;
  buffered_count: number | null;
};

export type MapNode = {
  node_id: number;
  lora_id: number;
  tree_label: string;
  farm_zone: string | null;
  cluster_id: string;
  location_lat: number;
  location_lon: number;
  status: Status;
  avg_confidence: number | null;
};

export type MapCluster = {
  cluster_id: string;
  name: string;
  farm_zone: string | null;
  location_lat: number | null;
  location_lon: number | null;
  revoked: boolean;
  last_seen: string | null;
  node_count: number;
};

export type EnergyPoint = {
  bucket: string;
  avg_energy: number | null;
  measurements: number;
};
export type EnergyOverviewPoint = EnergyPoint & {
  status: Status;
  nodes: number;
};

export type Member = {
  user_id: string;
  email: string;
  name: string;
  role: string;
  last_login: string | null;
};

export type Invite = { invite_id: string; email: string; expires_at: string };

export type ClusterHead = {
  cluster_id: string;
  name: string;
  farm_zone: string | null;
  location_lat: number | null;
  location_lon: number | null;
  uplink_type: string | null;
  api_key_created_at: string;
  revoked: boolean;
  node_count: number;
};

export type SettingsNode = {
  node_id: number;
  lora_id: number;
  tree_label: string;
  cluster_id: string;
  cluster_name: string;
  farm_zone: string | null;
  location_lat: number | null;
  location_lon: number | null;
  active: boolean;
};
