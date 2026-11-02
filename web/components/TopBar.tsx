"use client";

import {
  useIsFetching,
  useIsMutating,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Membership } from "@/lib/auth/current";
import { apiGet } from "@/lib/ui/api";
import { formatClock } from "@/lib/ui/format";
import { NAV_SECTIONS } from "@/lib/ui/nav";
import { useCurrentOrg } from "./OrgContext";

const selectClass =
  "max-w-[180px] rounded-sm border border-line-md bg-surface px-2 py-1.5 text-[12px] text-text-2 outline-none focus:border-accent";

function Clock({ timeZone }: { timeZone: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  return (
    <span
      className="hidden font-mono text-[11px] text-text-3 lg:inline"
      title={timeZone}
    >
      {now ? formatClock(now, timeZone) : "--:--:--"}
    </span>
  );
}

/** Green only while polling works, so the pill can't claim "Live" during an outage. */
function LivePill() {
  const client = useQueryClient();
  useIsFetching();
  useIsMutating();
  const failing = client
    .getQueryCache()
    .getAll()
    .some((q) => q.state.status === "error");
  return (
    <div
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        failing
          ? "border-danger/30 bg-danger-bg text-danger"
          : "border-accent/20 bg-accent-dim text-accent"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${failing ? "live-dot-off bg-danger" : "live-dot bg-accent"}`}
      />
      {failing ? "Disconnected" : "Live"}
    </div>
  );
}

export function TopBar({
  memberships,
  userName,
}: {
  memberships: Membership[];
  userName: string;
}) {
  const org = useCurrentOrg();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const zone = searchParams.get("zone") ?? "";

  const zones = useQuery({
    queryKey: ["zones", org.org_id],
    queryFn: () =>
      apiGet<{ items: { farm_zone: string; trees: number }[] }>(
        `/orgs/${org.org_id}/zones`,
      ),
  });

  const relative = pathname.slice(org.slug.length + 2);
  const title =
    NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.path === relative)
      ?.label ?? "Overview";

  function setZone(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("zone", next);
    else params.delete("zone");
    params.delete("page");
    const query = params.toString();
    router.push(`${pathname}${query ? `?${query}` : ""}`);
  }

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    // A full page load on purpose: it drops anything cached from the previous session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }

  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2.5 border-b border-line bg-surface px-4 py-3 md:px-7">
      <div className="flex min-w-0 items-center gap-2.5">
        <LivePill />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-medium text-text-1">
            {title}
          </h1>
          {memberships.length === 1 && (
            <div className="truncate text-[12px] text-text-3">{org.name}</div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {memberships.length > 1 && (
          <select
            aria-label="Organization"
            value={org.slug}
            onChange={(e) => router.push(`/${e.target.value}`)}
            className={selectClass}
          >
            {memberships.map((m) => (
              <option key={m.org_id} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Zone"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          className={selectClass}
        >
          <option value="">All zones</option>
          {zones.data?.items.map((z) => (
            <option key={z.farm_zone} value={z.farm_zone}>
              {z.farm_zone}
            </option>
          ))}
        </select>
        <Clock timeZone={org.timezone} />
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-sm bg-accent px-4 py-[7px] text-[12px] font-medium text-accent-text hover:opacity-85 [&::-webkit-details-marker]:hidden">
            Export report
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-52 rounded-sm border border-line-md bg-card-alt p-1 shadow-lg">
            <p className="px-2.5 py-1 text-[10px] tracking-[0.5px] text-text-3 uppercase">
              CSV, last 30 days
            </p>
            {[
              ["features", "Feature records"],
              ["classifications", "Classifications"],
              ["alerts", "Alerts"],
            ].map(([file, label]) => (
              <a
                key={file}
                href={`/api/v1/orgs/${org.org_id}/export/${file}.csv${zone ? `?zone=${encodeURIComponent(zone)}` : ""}`}
                className="block rounded-sm px-2.5 py-1.5 text-[12px] text-text-1 hover:bg-white/5"
              >
                {label}
              </a>
            ))}
          </div>
        </details>
        <button
          type="button"
          onClick={logout}
          title={`Log out ${userName}`}
          className="rounded-sm border border-line-md px-3 py-[7px] text-[12px] font-medium text-text-2 hover:opacity-85"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
