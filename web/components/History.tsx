"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet, type FeatureRecord, type MorePage } from "@/lib/ui/api";
import { dayEnd, dayStart, formatDateTime, percent } from "@/lib/ui/format";
import { useUrlParams } from "@/lib/ui/useUrlParams";
import { NodePicker } from "./NodePicker";
import { useCurrentOrg } from "./OrgContext";
import {
  EmptyState,
  ErrorState,
  ghostButton,
  inputClass,
  Pager,
  SectionHeader,
  tableWrap,
  tdClass,
  thClass,
} from "./States";

const PAGE_SIZE = 50;

export function History() {
  const org = useCurrentOrg();
  const { get, page, zone, setParams } = useUrlParams();
  const node = get("node");
  const nodeLabel = get("tree");
  const fromDate = get("from");
  const toDate = get("to");

  const filters = {
    node_id: node || undefined,
    zone,
    from: fromDate ? dayStart(fromDate) : undefined,
    to: toDate ? dayEnd(toDate) : undefined,
  };

  const records = useQuery({
    queryKey: ["history", org.org_id, filters, page],
    queryFn: () =>
      apiGet<MorePage<FeatureRecord>>(`/orgs/${org.org_id}/history`, {
        ...filters,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({
    queryKey: ["history-summary", org.org_id, filters],
    queryFn: () =>
      apiGet<{ total_records: number; positive_detections: number }>(
        `/orgs/${org.org_id}/history/summary`,
        filters,
      ),
  });

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) search.set(key, value);
  const csvHref = `/api/v1/orgs/${org.org_id}/export/features.csv${search.size ? `?${search}` : ""}`;

  return (
    <div>
      <SectionHeader
        title="Feature record history"
        meta={
          nodeLabel
            ? nodeLabel
            : fromDate || toDate
              ? "Selected dates"
              : "Last 7 days, all trees"
        }
      >
        <NodePicker
          value={node}
          allLabel="All trees"
          onChange={(id, label) =>
            setParams({ node: id, tree: label, page: null })
          }
        />
        {node && (
          <button
            type="button"
            onClick={() => setParams({ node: null, tree: null, page: null })}
            className={ghostButton}
          >
            Show all trees
          </button>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-text-3">
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setParams({ from: e.target.value, page: null })}
            className={`${inputClass} [color-scheme:dark]`}
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-text-3">
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setParams({ to: e.target.value, page: null })}
            className={`${inputClass} [color-scheme:dark]`}
          />
        </label>
        <a href={csvHref} className={ghostButton}>
          Export CSV
        </a>
      </SectionHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 md:max-w-md">
        <div className="rounded-md border border-line bg-card px-4 py-3.5">
          <div className="mb-1 text-[11px] tracking-[0.5px] text-text-3 uppercase">
            Records
          </div>
          <div
            className="text-[24px] font-light text-text-1"
            data-testid="history-total"
          >
            {summary.data?.total_records.toLocaleString() ?? "—"}
          </div>
        </div>
        <div className="rounded-md border border-line bg-card px-4 py-3.5">
          <div className="mb-1 text-[11px] tracking-[0.5px] text-text-3 uppercase">
            Positive detections
          </div>
          <div className="text-[24px] font-light text-warn">
            {summary.data?.positive_detections.toLocaleString() ?? "—"}
          </div>
        </div>
      </div>

      {records.isError && (
        <ErrorState what="the records" onRetry={() => records.refetch()} />
      )}
      {records.isPending && (
        <div className="h-64 animate-pulse rounded-lg border border-line bg-card" />
      )}
      {records.data?.items.length === 0 && (
        <EmptyState>No records in this period.</EmptyState>
      )}
      {records.data && records.data.items.length > 0 && (
        <div className={tableWrap}>
          <table
            className="w-full border-collapse"
            aria-busy={records.isFetching}
          >
            <thead>
              <tr>
                <th className={thClass}>Tree</th>
                <th className={thClass}>Time</th>
                <th
                  className={thClass}
                  title="Mean of MFCC c0 over the 30 frames: a log-energy value with no fixed scale"
                >
                  Energy (c0)
                </th>
                <th className={thClass}>SNR (dB)</th>
                <th className={thClass}>RSSI (dBm)</th>
                <th className={thClass}>Prediction</th>
              </tr>
            </thead>
            <tbody>
              {records.data.items.map((row) => (
                <tr
                  key={`${row.node_id}-${row.timestamp}`}
                  data-testid="history-row"
                  className="hover:bg-white/[0.02]"
                >
                  <td
                    className={`${tdClass} font-mono whitespace-nowrap text-text-1`}
                  >
                    {row.tree_label}
                  </td>
                  <td
                    className={`${tdClass} font-mono text-[11px] whitespace-nowrap text-text-3`}
                  >
                    {formatDateTime(row.timestamp, org.timezone)}
                  </td>
                  <td className={`${tdClass} font-mono`}>
                    {row.energy?.toFixed(1) ?? "—"}
                  </td>
                  <td className={`${tdClass} font-mono`}>
                    {row.snr_db?.toFixed(1) ?? "—"}
                  </td>
                  <td className={`${tdClass} font-mono`}>
                    {row.rssi_dbm ?? "—"}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {row.confidence === null ? (
                      <span className="text-text-3">
                        {row.status === "failed" ? "Failed" : "Pending"}
                      </span>
                    ) : (
                      <span className="font-mono text-text-1">
                        {percent(row.confidence)}{" "}
                        <span className="font-sans text-text-3">
                          {row.label}
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        hasMore={records.data?.has_more}
        onPage={(next) => setParams({ page: String(next) })}
      />
    </div>
  );
}
