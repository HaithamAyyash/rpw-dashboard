"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  apiGet,
  type ClusterHealth,
  type NodeHealth,
  type Page,
} from "@/lib/ui/api";
import {
  batteryClass,
  batteryPercent,
  formatDateTime,
  formatUptime,
  signalBars,
} from "@/lib/ui/format";
import { useUrlParams } from "@/lib/ui/useUrlParams";
import { useCurrentOrg } from "./OrgContext";
import {
  EmptyState,
  ErrorState,
  Pager,
  SectionHeader,
  SkeletonGrid,
} from "./States";
import { StatusBadge } from "./StatusBadge";

const PAGE_SIZE = 48;
const NO_DATA = <span className="font-normal text-text-3">No data yet</span>;
const BAR_HEIGHTS = [4, 7, 10, 14];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <div className="text-[11px] text-text-3">{label}</div>
      <div className="text-right text-[11px] font-medium text-text-2">
        {children}
      </div>
    </div>
  );
}

function SignalDots({ dbm }: { dbm: number }) {
  const on = signalBars(dbm);
  return (
    <span className="flex items-center gap-1.5" title={`${dbm} dBm`}>
      <span className="flex items-end gap-[3px]" aria-hidden="true">
        {BAR_HEIGHTS.map((height, index) => (
          <span
            key={height}
            className={`w-1 rounded-[1px] ${index < on ? "bg-accent" : "bg-white/10"}`}
            style={{ height }}
          />
        ))}
      </span>
      <span className="font-mono">{dbm} dBm</span>
    </span>
  );
}

function NodeCard({ node, timeZone }: { node: NodeHealth; timeZone: string }) {
  const battery =
    node.battery_mv === null ? null : batteryPercent(node.battery_mv);
  const colours = battery === null ? null : batteryClass(battery);
  return (
    <article
      data-testid="health-node"
      className="rounded-md border border-line bg-card px-4 py-3.5"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="truncate font-mono text-[13px] font-medium text-text-1">
          {node.tree_label}
        </div>
        <StatusBadge status={node.status} />
      </div>
      <Row label="Battery">
        {battery === null ? (
          NO_DATA
        ) : (
          <span className={colours!.text}>
            {battery}% · {node.battery_mv} mV
          </span>
        )}
      </Row>
      {battery !== null && (
        <div className="mb-2 h-[5px] overflow-hidden rounded-[3px] bg-white/7">
          <div
            className={`h-full rounded-[3px] ${colours!.bar}`}
            style={{ width: `${battery}%` }}
          />
        </div>
      )}
      <Row label="Signal">
        {node.rssi_dbm === null ? NO_DATA : <SignalDots dbm={node.rssi_dbm} />}
      </Row>
      <Row label="Zone">{node.farm_zone ?? "—"}</Row>
      <Row label="Uptime">
        {node.uptime_s === null ? NO_DATA : formatUptime(node.uptime_s)}
      </Row>
      <Row label="Last seen">
        {node.last_heartbeat
          ? formatDateTime(node.last_heartbeat, timeZone)
          : NO_DATA}
      </Row>
    </article>
  );
}

function ClusterCard({
  cluster,
  timeZone,
}: {
  cluster: ClusterHealth;
  timeZone: string;
}) {
  const sdLow = cluster.sd_free_mb !== null && cluster.sd_free_mb < 1024;
  return (
    <article
      data-testid="health-cluster"
      className="rounded-md border border-line bg-card px-4 py-3.5"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="truncate font-mono text-[13px] font-medium text-text-1">
          {cluster.name}
        </div>
        {cluster.revoked && (
          <span className="rounded-full border border-line bg-white/5 px-2 py-[3px] text-[10px] text-text-3">
            Revoked
          </span>
        )}
      </div>
      <Row label="Zone">{cluster.farm_zone ?? "—"}</Row>
      <Row label="Uplink">
        {cluster.uplink_type === "4g"
          ? "4G"
          : cluster.uplink_type === "wifi"
            ? "Wi-Fi"
            : NO_DATA}
      </Row>
      <Row label="Uptime">
        {cluster.uptime_s === null ? NO_DATA : formatUptime(cluster.uptime_s)}
      </Row>
      <Row label="SD free">
        {cluster.sd_free_mb === null ? (
          NO_DATA
        ) : (
          <span className={sdLow ? "text-danger" : ""}>
            {cluster.sd_free_mb.toLocaleString()} MB{sdLow ? " · low" : ""}
          </span>
        )}
      </Row>
      <Row label="Buffered">{cluster.buffered_count ?? NO_DATA}</Row>
      <Row label="Last seen">
        {cluster.last_seen
          ? formatDateTime(cluster.last_seen, timeZone)
          : NO_DATA}
      </Row>
    </article>
  );
}

const grid = "grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5";

export function Health() {
  const org = useCurrentOrg();
  const { page, zone, setParams } = useUrlParams();
  const clusters = useQuery({
    queryKey: ["health-clusters", org.org_id],
    queryFn: () =>
      apiGet<{ items: ClusterHealth[] }>(`/orgs/${org.org_id}/health/clusters`),
  });
  const nodes = useQuery({
    queryKey: ["health-nodes", org.org_id, zone, page],
    queryFn: () =>
      apiGet<Page<NodeHealth>>(`/orgs/${org.org_id}/health/nodes`, {
        zone,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <SectionHeader title="Cluster heads" />
      <div className={`${grid} mb-7`}>
        {clusters.isPending && (
          <SkeletonGrid count={2} className="h-[170px] rounded-md" />
        )}
        {clusters.isError && (
          <ErrorState
            what="the cluster heads"
            onRetry={() => clusters.refetch()}
          />
        )}
        {clusters.data?.items.length === 0 && (
          <EmptyState>
            No cluster heads yet. Register one in Settings.
          </EmptyState>
        )}
        {clusters.data?.items.map((c) => (
          <ClusterCard key={c.cluster_id} cluster={c} timeZone={org.timezone} />
        ))}
      </div>

      <SectionHeader
        title="Node health status"
        meta={nodes.data ? `${nodes.data.total} nodes` : undefined}
      />
      <div className={grid} aria-busy={nodes.isFetching}>
        {nodes.isPending && (
          <SkeletonGrid count={8} className="h-[170px] rounded-md" />
        )}
        {nodes.isError && (
          <ErrorState what="the nodes" onRetry={() => nodes.refetch()} />
        )}
        {nodes.data?.items.length === 0 && (
          <EmptyState>
            {zone ? "No nodes in this zone." : "No nodes yet."}
          </EmptyState>
        )}
        {nodes.data?.items.map((n) => (
          <NodeCard key={n.node_id} node={n} timeZone={org.timezone} />
        ))}
      </div>
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={nodes.data?.total}
        onPage={(next) => setParams({ page: String(next) })}
      />
    </div>
  );
}
