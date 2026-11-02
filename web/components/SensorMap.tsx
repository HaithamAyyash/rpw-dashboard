"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import {
  apiGet,
  type MapCluster,
  type MapNode,
  type Status,
} from "@/lib/ui/api";
import { percent } from "@/lib/ui/format";
import { useUrlParams } from "@/lib/ui/useUrlParams";
import { MAP_STATUS_COLORS } from "@/lib/ui/mapColors";
import type { MapHandle } from "./MapCanvas";
import { useCurrentOrg } from "./OrgContext";
import { EmptyState, ErrorState } from "./States";

// Leaflet needs a browser.
const MapCanvas = dynamic(
  () => import("./MapCanvas").then((m) => m.MapCanvas),
  {
    ssr: false,
    loading: () => <div className="h-full animate-pulse bg-white/5" />,
  },
);

const LEGEND: { status: Status; label: string }[] = [
  { status: "healthy", label: "Healthy — low risk" },
  { status: "suspected", label: "Suspected — elevated" },
  { status: "alert", label: "Alert — high confidence" },
  { status: "offline", label: "Offline — no heartbeat" },
  { status: "unknown", label: "No data yet" },
];
const ORDER: Record<Status, number> = {
  alert: 0,
  suspected: 1,
  offline: 2,
  unknown: 3,
  healthy: 4,
};
const LIST_LIMIT = 300;

export function SensorMap() {
  const org = useCurrentOrg();
  const { zone } = useUrlParams();
  const handle = useRef<MapHandle | null>(null);
  const [search, setSearch] = useState("");
  const map = useQuery({
    queryKey: ["map", org.org_id, zone],
    queryFn: () =>
      apiGet<{ nodes: MapNode[]; clusters: MapCluster[] }>(
        `/orgs/${org.org_id}/map`,
        { zone },
      ),
  });
  const nodes = map.data?.nodes ?? [];
  const counts = Object.fromEntries(
    LEGEND.map(({ status }) => [
      status,
      nodes.filter((n) => n.status === status).length,
    ]),
  );
  const needle = search.trim().toLowerCase();
  const listed = nodes
    .filter(
      (n) =>
        !needle ||
        n.tree_label.toLowerCase().includes(needle) ||
        String(n.lora_id) === needle,
    )
    .sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        a.tree_label.localeCompare(b.tree_label),
    );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1fr_280px]">
      <section
        className="overflow-hidden rounded-lg border border-line bg-card"
        aria-label="Sensor map"
      >
        {map.isError ? (
          <div className="p-4">
            <ErrorState what="the map" onRetry={() => map.refetch()} />
          </div>
        ) : (
          <div
            className="h-[60vh] min-h-[420px] lg:h-[calc(100vh-130px)]"
            data-testid="sensor-map"
          >
            {map.data && (
              <MapCanvas
                key={`${org.org_id}-${zone}`}
                nodes={map.data.nodes}
                clusters={map.data.clusters}
                orgSlug={org.slug}
                handleRef={handle}
              />
            )}
          </div>
        )}
      </section>

      <aside className="rounded-lg border border-line bg-card p-4">
        <h2 className="mb-3 text-[12px] font-medium text-text-1">
          Status legend
        </h2>
        {LEGEND.map(({ status, label }) => (
          <div
            key={status}
            className="mb-2 flex items-center gap-2 text-[12px] text-text-2"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/40"
              style={{ background: MAP_STATUS_COLORS[status] }}
            />
            <span className="flex-1">{label}</span>
            <span className="font-mono text-[11px] text-text-3">
              {counts[status]}
            </span>
          </div>
        ))}
        <div className="mb-3 flex items-center gap-2 text-[12px] text-text-2">
          <span className="ml-0.5 h-2 w-2 shrink-0 rotate-45 rounded-[1px] border border-white bg-[#5fa8e0]" />
          Cluster head, ~1 km coverage
        </div>

        <input
          type="search"
          aria-label="Search the node list"
          placeholder="Search label or LoRa ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full rounded-sm border border-line-md bg-surface px-2.5 py-[5px] text-[12px] text-text-1 outline-none placeholder:text-text-3 focus:border-accent"
        />
        <ul
          className="mt-2 max-h-[300px] overflow-y-auto"
          data-testid="map-node-list"
        >
          {listed.slice(0, LIST_LIMIT).map((node) => (
            <li key={node.node_id}>
              <button
                type="button"
                onClick={() => handle.current?.open(node.node_id)}
                className="flex w-full items-center justify-between gap-2 border-b border-white/[0.03] px-1 py-1.5 text-left text-[12px] hover:bg-white/5"
              >
                <span className="truncate font-mono text-text-2">
                  {node.tree_label}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-3">
                  {node.avg_confidence !== null && percent(node.avg_confidence)}
                  <span
                    className="h-[7px] w-[7px] rounded-full border border-white/40"
                    title={node.status}
                    style={{ background: MAP_STATUS_COLORS[node.status] }}
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
        {listed.length > LIST_LIMIT && (
          <p className="mt-2 text-[11px] text-text-3">
            Showing {LIST_LIMIT} of {listed.length}. Search to narrow the list.
          </p>
        )}
        {map.data && nodes.length === 0 && (
          <EmptyState>
            {zone
              ? "No located trees in this zone."
              : "No trees with coordinates yet. Add them in Settings."}
          </EmptyState>
        )}
      </aside>
    </div>
  );
}
