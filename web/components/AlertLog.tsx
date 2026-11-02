"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiGet, apiSend, type Alert, type MorePage } from "@/lib/ui/api";
import { formatDateTime, percent } from "@/lib/ui/format";
import { useUrlParams } from "@/lib/ui/useUrlParams";
import { useCurrentOrg } from "./OrgContext";
import {
  EmptyState,
  ErrorState,
  FilterButton,
  ghostButton,
  Pager,
  SectionHeader,
  SkeletonGrid,
} from "./States";

const PAGE_SIZE = 50;

const SEVERITY = {
  critical: {
    icon: "!",
    label: "Critical",
    className: "border-danger/20 bg-danger-bg text-danger",
  },
  warning: {
    icon: "~",
    label: "Warning",
    className: "border-warn/20 bg-warn-bg text-warn",
  },
  info: {
    icon: "i",
    label: "Info",
    className: "border-[#5fa8e0]/15 bg-[#5fa8e0]/12 text-[#5fa8e0]",
  },
} as const;

const TITLES: Record<string, string> = {
  infestation_detected: "Infestation detected",
  infestation_suspected: "Infestation suspected",
  node_offline: "Node offline",
  low_battery: "Low battery",
  cluster_offline: "Cluster head offline",
  sd_low: "SD card low",
};

export function AlertLog() {
  const org = useCurrentOrg();
  const client = useQueryClient();
  const { get, page, zone, setParams } = useUrlParams();
  const severity = get("severity");
  const open = get("open") === "1";

  const alerts = useQuery({
    queryKey: ["alerts", org.org_id, zone, severity, open, page],
    queryFn: () =>
      apiGet<MorePage<Alert>>(`/orgs/${org.org_id}/alerts`, {
        zone,
        severity,
        acknowledged: open ? "false" : undefined,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const acknowledge = useMutation({
    mutationFn: (id: number) =>
      apiSend("PATCH", `/orgs/${org.org_id}/alerts/${id}`, {
        acknowledged: true,
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["alerts", org.org_id] }),
  });

  return (
    <div>
      <SectionHeader title="Detection event log" meta="Newest first">
        {[
          ["", "All"],
          ["critical", "Critical"],
          ["warning", "Warning"],
          ["info", "Info"],
        ].map(([value, label]) => (
          <FilterButton
            key={label}
            on={severity === value}
            onClick={() => setParams({ severity: value!, page: null })}
          >
            {label}
          </FilterButton>
        ))}
        <FilterButton
          on={open}
          onClick={() => setParams({ open: open ? null : "1", page: null })}
        >
          Unacknowledged
        </FilterButton>
      </SectionHeader>

      {acknowledge.isError && (
        <p role="alert" className="mb-3 text-[12px] text-danger">
          Couldn&apos;t acknowledge: {acknowledge.error.message}
        </p>
      )}

      <div className="flex flex-col gap-2" aria-busy={alerts.isFetching}>
        {alerts.isPending && (
          <SkeletonGrid count={6} className="h-[68px] rounded-md" />
        )}
        {alerts.isError && (
          <ErrorState what="the alerts" onRetry={() => alerts.refetch()} />
        )}
        {alerts.data?.items.length === 0 && (
          <EmptyState>
            {severity || open || zone
              ? "No alerts match this filter."
              : "No alerts yet."}
          </EmptyState>
        )}
        {alerts.data?.items.map((alert) => {
          const style = SEVERITY[alert.severity];
          return (
            <article
              key={alert.alert_id}
              data-testid="alert-row"
              className="flex flex-wrap items-start gap-3.5 rounded-md border border-line bg-card px-4 py-3.5 hover:border-line-md"
            >
              <div
                title={style.label}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border text-[13px] font-bold ${style.className}`}
              >
                <span aria-hidden="true">{style.icon}</span>
                <span className="sr-only">{style.label}</span>
              </div>
              <div className="min-w-[200px] flex-1">
                <div className="text-[13px] font-medium text-text-1">
                  {TITLES[alert.alert_type] ?? alert.alert_type}
                  {alert.tree_label ? ` — ${alert.tree_label}` : ""}
                  {alert.cluster_name ? ` — ${alert.cluster_name}` : ""}
                </div>
                <div className="mt-0.5 text-[12px] text-text-3">
                  {alert.message}
                </div>
                {alert.acknowledged && (
                  <div className="mt-1 text-[11px] text-text-3">
                    Acknowledged by{" "}
                    {alert.acknowledged_by_name ?? "a former member"}
                    {alert.acknowledged_at
                      ? `, ${formatDateTime(alert.acknowledged_at, org.timezone)}`
                      : ""}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="text-right">
                  <div className="font-mono text-[11px] text-text-3">
                    {formatDateTime(alert.timestamp, org.timezone)}
                  </div>
                  {alert.confidence !== null && (
                    <div className="mt-1 font-mono text-[12px] font-medium text-text-1">
                      {percent(alert.confidence)}
                    </div>
                  )}
                </div>
                {!alert.acknowledged && (
                  <button
                    type="button"
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate(alert.alert_id)}
                    className={ghostButton}
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        hasMore={alerts.data?.has_more}
        onPage={(next) => setParams({ page: String(next) })}
      />
    </div>
  );
}
