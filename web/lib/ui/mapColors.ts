import type { Status } from "./api";

// Its own file: importing these must not pull Leaflet, which needs a browser, into server rendering.
export const MAP_STATUS_COLORS: Record<Status, string> = {
  healthy: "#7CEA9C",
  suspected: "#f5a623",
  alert: "#e05555",
  offline: "#2e4035",
  unknown: "#8fa490",
};
