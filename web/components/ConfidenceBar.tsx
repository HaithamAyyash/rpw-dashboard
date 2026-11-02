import type { OrgSettings } from "@/lib/ui/api";
import { percent } from "@/lib/ui/format";

/** The number is always there, so meaning never depends on colour alone. */
export function ConfidenceBar({
  value,
  org,
}: {
  value: number;
  org?: OrgSettings;
}) {
  const fill =
    !org || value < org.suspect_threshold
      ? "bg-accent"
      : value < org.alert_threshold
        ? "bg-warn"
        : "bg-danger";
  return (
    <div className="flex min-w-[110px] items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-sm bg-white/7">
        <div
          className={`h-full rounded-sm ${fill}`}
          style={{ width: percent(value) }}
        />
      </div>
      <span className="min-w-8 text-right font-mono text-[11px] text-text-1">
        {percent(value)}
      </span>
    </div>
  );
}
