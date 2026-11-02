"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet, type Classification as Row, type Page } from "@/lib/ui/api";
import { formatDateTime } from "@/lib/ui/format";
import { useUrlParams } from "@/lib/ui/useUrlParams";
import { ConfidenceBar } from "./ConfidenceBar";
import { useCurrentOrg } from "./OrgContext";
import {
  EmptyState,
  ErrorState,
  FilterButton,
  Pager,
  SectionHeader,
  tableWrap,
  tdClass,
  thClass,
} from "./States";
import { StatusBadge } from "./StatusBadge";
import { useOrgSettings } from "./useOrgSettings";

const PAGE_SIZE = 50;

/** Sort columns, and the order each starts in. Default: highest confidence first. */
const SORTS: Record<string, { key: string; label: string }> = {
  tree: { key: "tree_asc", label: "Tree" },
  confidence: { key: "confidence_desc", label: "Confidence" },
  time: { key: "time_desc", label: "Time" },
};

function SortHeader({
  column,
  sort,
  onSort,
}: {
  column: string;
  sort: string;
  onSort: (key: string) => void;
}) {
  const { key, label: name } = SORTS[column]!;
  const on = sort === key;
  return (
    <th
      className={thClass}
      aria-sort={
        on ? (key.endsWith("asc") ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(key)}
        className={`tracking-[0.5px] uppercase hover:text-text-1 ${on ? "text-accent" : ""}`}
      >
        {name}
        {on ? (key.endsWith("asc") ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}

export function Classification() {
  const org = useCurrentOrg();
  const settings = useOrgSettings();
  const { get, page, zone, setParams } = useUrlParams();
  const label = get("label");
  const sort = get("sort") || "confidence_desc";
  const setSort = (key: string) => setParams({ sort: key, page: null });

  const results = useQuery({
    queryKey: ["classifications", org.org_id, zone, label, sort, page],
    queryFn: () =>
      apiGet<Page<Row>>(`/orgs/${org.org_id}/classifications`, {
        zone,
        label,
        sort,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <SectionHeader
        title="Model classification results"
        meta={`Latest result per node${results.data ? ` · ${results.data.total} nodes` : ""}`}
      >
        {[
          ["", "All"],
          ["healthy", "Healthy"],
          ["infested", "Infested"],
        ].map(([value, name]) => (
          <FilterButton
            key={name}
            on={label === value}
            onClick={() => setParams({ label: value!, page: null })}
          >
            {name}
          </FilterButton>
        ))}
      </SectionHeader>

      {results.isError && (
        <ErrorState what="the results" onRetry={() => results.refetch()} />
      )}
      {results.isPending && (
        <div className="h-64 animate-pulse rounded-lg border border-line bg-card" />
      )}
      {results.data?.items.length === 0 && (
        <EmptyState>
          {label || zone ? "No results match this filter." : "No results yet."}
        </EmptyState>
      )}
      {results.data && results.data.items.length > 0 && (
        <div className={tableWrap}>
          <table
            className="w-full border-collapse"
            aria-busy={results.isFetching}
          >
            <thead>
              <tr>
                <SortHeader column="tree" sort={sort} onSort={setSort} />
                <th className={thClass}>LoRa ID</th>
                <th className={thClass}>Model version</th>
                <th className={thClass}>Label</th>
                <SortHeader column="confidence" sort={sort} onSort={setSort} />
                <th className={thClass}>Status</th>
                <SortHeader column="time" sort={sort} onSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {results.data.items.map((row) => (
                <tr
                  key={row.node_id}
                  data-testid="classification-row"
                  className="hover:bg-white/[0.02]"
                >
                  <td
                    className={`${tdClass} font-mono whitespace-nowrap text-text-1`}
                  >
                    {row.tree_label}
                  </td>
                  <td className={`${tdClass} font-mono`}>{row.lora_id}</td>
                  <td className={tdClass}>
                    <span className="rounded-[3px] border border-[#5fa8e0]/15 bg-[#5fa8e0]/12 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-[#5fa8e0]">
                      {row.model_version}
                    </span>
                  </td>
                  <td className={`${tdClass} capitalize`}>{row.label}</td>
                  <td className={tdClass}>
                    <ConfidenceBar value={row.confidence} org={settings.data} />
                  </td>
                  <td className={tdClass}>
                    {row.status && <StatusBadge status={row.status} />}
                  </td>
                  <td
                    className={`${tdClass} font-mono text-[11px] whitespace-nowrap text-text-3`}
                  >
                    {formatDateTime(row.timestamp, org.timezone)}
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
        total={results.data?.total}
        onPage={(next) => setParams({ page: String(next) })}
      />
    </div>
  );
}
