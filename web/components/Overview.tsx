"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  apiGet,
  type OrgSettings,
  type Page,
  type Status,
  type Summary,
  type Tree,
} from "@/lib/ui/api";
import { useCurrentOrg } from "./OrgContext";
import { TreeCard } from "./TreeCard";

const PAGE_SIZE = 48;
const FILTERS: { label: string; value: Status | "" }[] = [
  { label: "All", value: "" },
  { label: "Healthy", value: "healthy" },
  { label: "Suspected", value: "suspected" },
  { label: "Alert", value: "alert" },
  { label: "Offline", value: "offline" },
];

function StatCard({
  label,
  bar,
  value,
  fraction,
  valueClass = "text-text-1",
  note,
  noteClass = "text-text-3",
}: {
  label: string;
  bar?: "accent" | "warn";
  value: string | number;
  fraction?: string;
  valueClass?: string;
  note: string;
  noteClass?: string;
}) {
  const barClass =
    bar === "accent" ? "bg-accent" : bar === "warn" ? "bg-warn" : "bg-line";
  return (
    <div className="relative overflow-hidden rounded-md border border-line bg-card px-[18px] py-4">
      <div
        data-testid="stat-bar"
        className={`absolute inset-x-0 top-0 h-0.5 ${barClass}`}
      />
      <div className="mb-1.5 text-[11px] tracking-[0.6px] text-text-3 uppercase">
        {label}
      </div>
      <div
        className={`flex items-baseline gap-1 text-[30px] leading-none font-light ${valueClass}`}
      >
        {value}
        {fraction && (
          <span className="text-[15px] font-normal text-text-3">
            {fraction}
          </span>
        )}
      </div>
      <div className={`mt-1.5 text-[11px] ${noteClass}`}>{note}</div>
    </div>
  );
}

function SkeletonGrid({
  count,
  className,
}: {
  count: number;
  className: string;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={`animate-pulse rounded-lg border border-line bg-card ${className}`}
        />
      ))}
    </>
  );
}

function ErrorState({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="col-span-full rounded-md border border-danger/30 bg-danger-bg p-6 text-center text-[13px]"
    >
      <p className="mb-2 text-text-1">Couldn&apos;t load {what}.</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm border border-line-md px-3 py-1.5 text-[12px] text-text-1 hover:opacity-85"
      >
        Try again
      </button>
    </div>
  );
}

function changeNote(change: number): { text: string; className: string } {
  if (change > 0)
    return { text: `↑ +${change} since yesterday`, className: "text-warn" };
  if (change < 0)
    return { text: `↓ ${change} since yesterday`, className: "text-accent" };
  return { text: "No change since yesterday", className: "text-text-3" };
}

function SummaryCards({ summary }: { summary: Summary }) {
  const change = changeNote(summary.suspected_change);
  const hasHealthData = summary.with_heartbeat > 0;
  return (
    <>
      <StatCard
        label="Trees monitored"
        bar="accent"
        value={summary.trees_monitored}
        note={`${summary.alerts} on alert`}
      />
      <StatCard
        label="Suspected infections"
        bar="warn"
        value={summary.suspected}
        valueClass="text-warn"
        note={change.text}
        noteClass={change.className}
      />
      {/* Without heartbeats a silent node might be healthy or dead, so we don't guess (D2). */}
      <StatCard
        label="Active nodes"
        bar="accent"
        value={hasHealthData ? summary.active_nodes : "—"}
        fraction={`/${summary.total_nodes}`}
        valueClass="text-accent"
        note={
          hasHealthData
            ? `${summary.offline} nodes offline`
            : "No health data yet"
        }
      />
      <StatCard
        label="Measurements / hr"
        value={summary.measurements_last_hour}
        note="In the last hour"
      />
    </>
  );
}

export function Overview() {
  const org = useCurrentOrg();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const zone = searchParams.get("zone") ?? "";
  const status = (searchParams.get("status") ?? "") as Status | "";
  const urlSearch = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [search, setSearch] = useState(urlSearch);

  function setParams(changes: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  useEffect(() => {
    if (search === urlSearch) return undefined;
    const timer = setTimeout(() => setParams({ q: search, page: "" }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change in the box should fire
  }, [search]);

  const settings = useQuery({
    queryKey: ["org", org.org_id],
    queryFn: () => apiGet<OrgSettings>(`/orgs/${org.org_id}`),
  });
  const summary = useQuery({
    queryKey: ["summary", org.org_id, zone],
    queryFn: () => apiGet<Summary>(`/orgs/${org.org_id}/summary`, { zone }),
  });
  const trees = useQuery({
    queryKey: ["trees", org.org_id, zone, status, urlSearch, page],
    queryFn: () =>
      apiGet<Page<Tree>>(`/orgs/${org.org_id}/trees`, {
        zone,
        status,
        q: urlSearch,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const total = trees.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterName = FILTERS.find(
    (f) => f.value === status,
  )?.label.toLowerCase();

  return (
    <div>
      <section
        aria-label="Summary"
        className="mb-6 grid grid-cols-2 gap-3 min-[900px]:grid-cols-4"
      >
        {summary.isPending && (
          <SkeletonGrid count={4} className="h-[100px] rounded-md" />
        )}
        {summary.isError && (
          <ErrorState what="the summary" onRetry={() => summary.refetch()} />
        )}
        {summary.data && <SummaryCards summary={summary.data} />}
      </section>

      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline">
          <h2 className="text-[14px] font-medium text-text-1">
            Monitored trees
          </h2>
          {trees.data && (
            <span
              className="ml-1.5 text-[12px] text-text-3"
              data-testid="tree-count"
            >
              {total} {status ? filterName : total === 1 ? "tree" : "trees"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="search"
            aria-label="Search trees"
            placeholder="Search label or LoRa ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-[180px] rounded-sm border border-line-md bg-surface px-3 py-[5px] text-[12px] text-text-1 outline-none placeholder:text-text-3 focus:border-accent"
          />
          {FILTERS.map((filter) => {
            const on = status === filter.value;
            return (
              <button
                key={filter.label}
                type="button"
                aria-pressed={on}
                onClick={() => setParams({ status: filter.value, page: "" })}
                className={`rounded-sm border px-3.5 py-[5px] text-[12px] transition-colors ${
                  on
                    ? "border-accent bg-accent font-medium text-accent-text"
                    : "border-line-md text-text-2 hover:bg-white/5 hover:text-text-1"
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>

      <section
        aria-label="Trees"
        aria-busy={trees.isFetching}
        className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3"
      >
        {(trees.isPending || settings.isPending) && (
          <SkeletonGrid count={8} className="h-[300px]" />
        )}
        {trees.isError && (
          <ErrorState what="the trees" onRetry={() => trees.refetch()} />
        )}
        {settings.isError && (
          <ErrorState what="the settings" onRetry={() => settings.refetch()} />
        )}
        {trees.data && total === 0 && (
          <div className="col-span-full px-6 py-10 text-center text-[13px] text-text-3">
            {status || urlSearch || zone
              ? "No trees match this filter."
              : "No trees yet. Nodes appear here once they're registered."}
          </div>
        )}
        {trees.data &&
          settings.data &&
          trees.data.items.map((tree) => (
            <TreeCard key={tree.node_id} tree={tree} org={settings.data} />
          ))}
      </section>

      {total > PAGE_SIZE && (
        <nav
          aria-label="Pages"
          className="mt-5 flex items-center justify-center gap-3 text-[12px]"
        >
          <button
            type="button"
            disabled={page <= 1}
            onClick={() =>
              setParams({ page: page > 2 ? String(page - 1) : "" })
            }
            className="rounded-sm border border-line-md px-3 py-1.5 text-text-2 hover:bg-white/5 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="font-mono text-text-3">
            {page} / {lastPage}
          </span>
          <button
            type="button"
            disabled={page >= lastPage}
            onClick={() => setParams({ page: String(page + 1) })}
            className="rounded-sm border border-line-md px-3 py-1.5 text-text-2 hover:bg-white/5 disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
