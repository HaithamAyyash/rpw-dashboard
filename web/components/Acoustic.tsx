"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import {
  apiGet,
  type Classification as ClassificationRow,
  type EnergyOverviewPoint,
  type EnergyPoint,
  type Page,
  type Status,
} from "@/lib/ui/api";
import { formatDateTime } from "@/lib/ui/format";
import { useUrlParams } from "@/lib/ui/useUrlParams";
import { NodePicker } from "./NodePicker";
import { useCurrentOrg } from "./OrgContext";
import {
  EmptyState,
  ErrorState,
  FilterButton,
  ghostButton,
  SectionHeader,
  tableWrap,
  tdClass,
  thClass,
} from "./States";
import { StatusBadge } from "./StatusBadge";

// Chart.js needs a browser.
const EnergyChart = dynamic(
  () => import("./EnergyChart").then((m) => m.EnergyChart),
  { ssr: false },
);

const RANGES = {
  "12h": { label: "12 h", hours: 12, bucket: "1h" },
  "24h": { label: "24 h", hours: 24, bucket: "1h" },
  "7d": { label: "7 d", hours: 168, bucket: "6h" },
} as const;
type RangeKey = keyof typeof RANGES;

// Status colours from the brief. Dashes are the second cue, so colour never works alone.
const LINES: Record<string, { label: string; color: string; dash?: number[] }> =
  {
    healthy: { label: "Healthy average", color: "#7CEA9C" },
    suspected: { label: "Suspected", color: "#f5a623", dash: [7, 4] },
    alert: { label: "Alert", color: "#e05555", dash: [2, 3] },
  };
const STATUS_COLOR: Record<string, string> = {
  healthy: "#7CEA9C",
  suspected: "#f5a623",
  alert: "#e05555",
  offline: "#8fa490",
  unknown: "#8fa490",
};
const AXIS_NOTE =
  "Mean c0: log energy with no fixed scale; closer to zero is louder";
const SMALL_MULTIPLES = 8;

function rangeFrom(range: RangeKey) {
  return new Date(Date.now() - RANGES[range].hours * 3_600_000).toISOString();
}

function shortTime(iso: string, timeZone: string, range: RangeKey) {
  const options: Intl.DateTimeFormatOptions =
    range === "7d"
      ? {
          timeZone,
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          hour12: false,
        }
      : { timeZone, hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat("en-GB", options).format(new Date(iso));
}

function Overlay({ range, zone }: { range: RangeKey; zone: string }) {
  const org = useCurrentOrg();
  const overview = useQuery({
    queryKey: ["energy-overview", org.org_id, range, zone],
    queryFn: () =>
      apiGet<{ items: EnergyOverviewPoint[] }>(
        `/orgs/${org.org_id}/energy/overview`,
        {
          from: rangeFrom(range),
          bucket: RANGES[range].bucket,
          zone,
        },
      ),
  });

  const chart = useMemo(() => {
    const items = overview.data?.items ?? [];
    const buckets = [...new Set(items.map((p) => p.bucket))].sort();
    const statuses = Object.keys(LINES).filter((status) =>
      items.some((p) => p.status === status),
    );
    return {
      buckets,
      labels: buckets.map((b) => shortTime(b, org.timezone, range)),
      series: statuses.map((status) => ({
        ...LINES[status]!,
        points: buckets.map(
          (b) =>
            items.find((p) => p.bucket === b && p.status === status)
              ?.avg_energy ?? null,
        ),
      })),
    };
  }, [overview.data, org.timezone, range]);

  return (
    <section className="mb-3.5 rounded-lg border border-line bg-card p-4">
      <h3 className="text-[12px] font-medium text-text-1">
        Acoustic energy by tree status
      </h3>
      <p className="mb-3 text-[11px] text-text-3">
        {AXIS_NOTE}. Trees are grouped by their current status.
      </p>
      {overview.isError && (
        <ErrorState what="the chart" onRetry={() => overview.refetch()} />
      )}
      {overview.isPending && (
        <div className="h-[240px] animate-pulse rounded-md bg-white/5" />
      )}
      {overview.data && chart.buckets.length === 0 && (
        <EmptyState>No measurements in this period.</EmptyState>
      )}
      {chart.buckets.length > 0 && (
        <>
          <div className="h-[240px]" data-testid="energy-overview">
            <EnergyChart
              labels={chart.labels}
              series={chart.series}
              showLegend
              ariaLabel="Acoustic energy over time for healthy, suspected and alert trees"
            />
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-text-3 hover:text-text-2">
              Show as a table
            </summary>
            <div className={`${tableWrap} mt-2 max-h-64 overflow-y-auto`}>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={thClass}>Time</th>
                    {chart.series.map((s) => (
                      <th key={s.label} className={thClass}>
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chart.buckets.map((bucket, index) => (
                    <tr key={bucket}>
                      <td className={`${tdClass} font-mono`}>
                        {formatDateTime(bucket, org.timezone)}
                      </td>
                      {chart.series.map((s) => (
                        <td key={s.label} className={`${tdClass} font-mono`}>
                          {s.points[index]?.toFixed(1) ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function NodeChart({
  node,
  range,
  onRemove,
}: {
  node: { node_id: string | number; tree_label: string; status?: Status };
  range: RangeKey;
  onRemove?: () => void;
}) {
  const org = useCurrentOrg();
  const energy = useQuery({
    queryKey: ["energy-node", org.org_id, node.node_id, range],
    queryFn: () =>
      apiGet<{ items: EnergyPoint[] }>(
        `/orgs/${org.org_id}/nodes/${node.node_id}/energy`,
        {
          from: rangeFrom(range),
          bucket: RANGES[range].bucket,
        },
      ),
  });
  const items = energy.data?.items ?? [];
  return (
    <article
      data-testid="energy-node"
      className="rounded-lg border border-line bg-card p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="truncate font-mono text-[12px] font-medium text-text-1">
          {node.tree_label}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          {node.status && <StatusBadge status={node.status} />}
          {onRemove && (
            <button type="button" onClick={onRemove} className={ghostButton}>
              Clear
            </button>
          )}
        </div>
      </div>
      {energy.isError && (
        <ErrorState what="this tree" onRetry={() => energy.refetch()} />
      )}
      {energy.isPending && (
        <div className="h-[140px] animate-pulse rounded-md bg-white/5" />
      )}
      {energy.data && items.length === 0 && (
        <p className="flex h-[140px] items-center justify-center text-[12px] text-text-3">
          No measurements in this period.
        </p>
      )}
      {items.length > 0 && (
        <div className="h-[140px]">
          <EnergyChart
            labels={items.map((p) => shortTime(p.bucket, org.timezone, range))}
            series={[
              {
                label: node.tree_label,
                color: STATUS_COLOR[node.status ?? "healthy"]!,
                points: items.map((p) => p.avg_energy),
              },
            ]}
            showLegend={false}
            ariaLabel={`Acoustic energy over time for ${node.tree_label}`}
          />
        </div>
      )}
    </article>
  );
}

export function Acoustic() {
  const org = useCurrentOrg();
  const { get, zone, setParams } = useUrlParams();
  const rangeParam = get("range");
  const range: RangeKey =
    rangeParam in RANGES ? (rangeParam as RangeKey) : "24h";
  const picked = get("node");
  const pickedLabel = get("tree");

  // The trees most worth looking at: highest latest confidence first.
  const top = useQuery({
    queryKey: ["energy-top", org.org_id, zone],
    queryFn: () =>
      apiGet<Page<ClassificationRow>>(`/orgs/${org.org_id}/classifications`, {
        sort: "confidence_desc",
        page_size: SMALL_MULTIPLES,
        zone,
      }),
  });

  return (
    <div>
      <SectionHeader
        title="Acoustic energy levels"
        meta={`Last ${RANGES[range].label}`}
      >
        {(Object.keys(RANGES) as RangeKey[]).map((key) => (
          <FilterButton
            key={key}
            on={range === key}
            onClick={() => setParams({ range: key })}
          >
            {RANGES[key].label}
          </FilterButton>
        ))}
        <NodePicker
          value={picked}
          onChange={(id, label) => setParams({ node: id, tree: label })}
        />
      </SectionHeader>

      <Overlay range={range} zone={zone} />

      <SectionHeader
        title="Per tree"
        meta={`Highest confidence first, up to ${SMALL_MULTIPLES}`}
      />
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        {picked && (
          <NodeChart
            key={`picked-${picked}`}
            node={{
              node_id: picked,
              tree_label: pickedLabel || `Node ${picked}`,
            }}
            range={range}
            onRemove={() => setParams({ node: null, tree: null })}
          />
        )}
        {top.isError && (
          <ErrorState what="the trees" onRetry={() => top.refetch()} />
        )}
        {top.data?.items.length === 0 && (
          <EmptyState>No classified trees yet.</EmptyState>
        )}
        {top.data?.items
          .filter((row) => String(row.node_id) !== picked)
          .map((row) => (
            <NodeChart key={row.node_id} node={row} range={range} />
          ))}
      </div>
    </div>
  );
}
