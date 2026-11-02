import type { OrgSettings, Tree } from "@/lib/ui/api";
import {
  batteryClass,
  batteryPercent,
  directionsUrl,
  formatDateTime,
} from "@/lib/ui/format";
import { StatusBadge } from "./StatusBadge";

/** Colours follow the organization's own thresholds, not the prototype's fixed 25% / 55%. */
function bandClass(
  value: number,
  org: OrgSettings,
  kinds: [string, string, string],
): string {
  if (value >= org.alert_threshold) return kinds[2];
  if (value >= org.suspect_threshold) return kinds[1];
  return kinds[0];
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-text-3">{label}</span>
      <span className="text-right text-[11px] font-medium text-text-2">
        {children}
      </span>
    </div>
  );
}

export function TreeCard({ tree, org }: { tree: Tree; org: OrgSettings }) {
  const average = tree.avg_confidence;
  const hasLocation = tree.location_lat !== null && tree.location_lon !== null;
  const battery =
    tree.battery_mv === null ? null : batteryPercent(tree.battery_mv);

  return (
    <article
      data-testid="tree-card"
      className="flex flex-col rounded-lg border border-line bg-card px-[18px] py-4 transition-colors hover:border-line-md hover:bg-card-alt"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[14px] font-medium text-text-1">
            {tree.tree_label}
          </div>
          <div className="truncate text-[11px] text-text-3">
            LoRa {tree.lora_id}
            {tree.farm_zone ? ` · ${tree.farm_zone}` : ""}
          </div>
        </div>
        <StatusBadge status={tree.status} />
      </div>

      <div className="mb-1 flex justify-between text-[11px] text-text-3">
        <span>Avg. infestation prediction</span>
        <span className="font-mono font-medium text-text-2">
          {average === null ? "—" : `${Math.round(average * 100)}%`}
        </span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-sm bg-white/7">
        {average !== null && (
          <div
            className={`h-full rounded-sm ${bandClass(average, org, ["bg-accent", "bg-warn", "bg-danger"])}`}
            style={{ width: `${Math.round(average * 100)}%` }}
          />
        )}
      </div>

      <div className="mb-1 text-[10px] tracking-[0.5px] text-text-3 uppercase">
        Last 3 runs
      </div>
      <div className="mb-3 flex gap-1.5">
        {tree.last_runs?.length ? (
          tree.last_runs.map((run, index) => (
            <div
              key={index}
              className={`flex-1 rounded-[4px] py-1 text-center font-mono text-[10px] font-medium ${bandClass(
                run,
                org,
                [
                  "bg-accent/10 text-[#5fbe80]",
                  "bg-warn-bg text-warn",
                  "bg-danger-bg text-danger",
                ],
              )}`}
            >
              {Math.round(run * 100)}%
            </div>
          ))
        ) : (
          <div className="flex-1 rounded-[4px] bg-white/5 py-1 text-center text-[10px] text-text-3">
            No runs yet
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-1.5 border-t border-line pt-2.5">
        <Row label="Measurements">{tree.measurements_24h} in last 24 h</Row>
        <Row label="Last measurement">
          {tree.last_measurement
            ? formatDateTime(tree.last_measurement, org.timezone)
            : "None yet"}
        </Row>
        <Row label="Battery">
          {battery === null ? (
            <span className="text-text-3">No data yet</span>
          ) : (
            <span className={batteryClass(battery).text}>
              {battery}% · {tree.battery_mv} mV
            </span>
          )}
        </Row>
      </div>

      {hasLocation ? (
        <a
          href={directionsUrl(tree.location_lat!, tree.location_lon!)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 rounded-sm border border-line-md py-1.5 text-center text-[12px] font-medium text-text-2 transition-colors hover:bg-white/5 hover:text-text-1"
        >
          Navigate to tree
        </a>
      ) : (
        <span className="mt-3 rounded-sm border border-line py-1.5 text-center text-[12px] text-text-3">
          No location set
        </span>
      )}
    </article>
  );
}
