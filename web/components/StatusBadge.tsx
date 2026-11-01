import type { Status } from "@/lib/ui/api";

const STYLES: Record<Status, { label: string; className: string }> = {
  healthy: {
    label: "Healthy",
    className: "bg-accent-dim text-[#5fbe80] border-accent/20",
  },
  suspected: {
    label: "Suspected",
    className: "bg-warn-bg text-warn border-warn/20",
  },
  alert: {
    label: "Alert",
    className: "bg-danger-bg text-danger border-danger/20",
  },
  offline: {
    label: "Offline",
    className: "bg-[var(--status-offline)]/50 text-text-2 border-line",
  },
  unknown: {
    label: "No data",
    className: "bg-white/5 text-text-3 border-line",
  },
};

export function StatusBadge({ status }: { status: Status }) {
  const style = STYLES[status];
  return (
    <span
      className={`rounded-full border px-2 py-[3px] text-[10px] font-medium tracking-[0.2px] whitespace-nowrap ${style.className}`}
    >
      {style.label}
    </span>
  );
}
