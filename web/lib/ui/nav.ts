export type NavIcon =
  | "overview"
  | "map"
  | "acoustic"
  | "classification"
  | "alerts"
  | "history"
  | "health"
  | "settings";

export type NavItem = { label: string; path: string; icon: NavIcon };

export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Monitoring",
    items: [
      { label: "Overview", path: "", icon: "overview" },
      { label: "Sensor map", path: "map", icon: "map" },
      { label: "Acoustic analysis", path: "acoustic", icon: "acoustic" },
    ],
  },
  {
    label: "Intelligence",
    items: [
      {
        label: "Classification",
        path: "classification",
        icon: "classification",
      },
      { label: "Alert log", path: "alerts", icon: "alerts" },
      { label: "Historical records", path: "history", icon: "history" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "System health", path: "health", icon: "health" },
      { label: "Settings", path: "settings", icon: "settings" },
    ],
  },
];
