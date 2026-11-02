"use client";

import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
);

const TEXT_MUTED = "#8fa490";
const AXIS_TEXT = "#8fa490";
const GRID = "rgba(255,255,255,0.05)";

export type Series = {
  label: string;
  color: string;
  dash?: number[]; // a second cue besides colour, for colour-blind readers
  points: (number | null)[];
};

export function EnergyChart({
  labels,
  series,
  showLegend,
  ariaLabel,
}: {
  labels: string[];
  series: Series[];
  showLegend: boolean;
  ariaLabel: string;
}) {
  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: showLegend,
        align: "start",
        labels: {
          color: TEXT_MUTED,
          boxWidth: 26,
          boxHeight: 2,
          font: { size: 11 },
        },
      },
      tooltip: {
        backgroundColor: "#242b29",
        titleColor: "#dde8de",
        bodyColor: "#dde8de",
        borderColor: "rgba(255,255,255,0.16)",
        borderWidth: 1,
        callbacks: {
          label: (item) =>
            `${item.dataset.label}: ${Number(item.parsed.y).toFixed(1)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: AXIS_TEXT,
          font: { size: 10 },
          maxTicksLimit: 8,
          maxRotation: 0,
        },
        grid: { display: false },
      },
      y: {
        ticks: { color: AXIS_TEXT, font: { size: 10 }, maxTicksLimit: 5 },
        grid: { color: GRID },
        border: { display: false },
      },
    },
  };
  return (
    <Line
      aria-label={ariaLabel}
      role="img"
      options={options}
      data={{
        labels,
        datasets: series.map((s) => ({
          label: s.label,
          data: s.points,
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: 2,
          borderDash: s.dash,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 12,
          tension: 0.25,
          spanGaps: true, // with SNR gating, healthy trees often have empty hours
        })),
      }}
    />
  );
}
