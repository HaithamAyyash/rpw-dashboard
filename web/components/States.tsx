"use client";

import type { ReactNode } from "react";

export function SkeletonGrid({
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

export function ErrorState({
  what,
  onRetry,
}: {
  what: string;
  onRetry: () => void;
}) {
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

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="col-span-full px-6 py-10 text-center text-[13px] text-text-3">
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <h2 className="text-[14px] font-medium text-text-1">{title}</h2>
        {meta && <span className="text-[12px] text-text-3">{meta}</span>}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      )}
    </div>
  );
}

export function FilterButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-sm border px-3.5 py-[5px] text-[12px] transition-colors ${
        on
          ? "border-accent bg-accent font-medium text-accent-text"
          : "border-line-md text-text-2 hover:bg-white/5 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

/** Previous and Next. Pass total for "3 / 12", or hasMore when counting would be too slow. */
export function Pager({
  page,
  pageSize,
  total,
  hasMore,
  onPage,
}: {
  page: number;
  pageSize: number;
  total?: number;
  hasMore?: boolean;
  onPage: (page: number) => void;
}) {
  const last =
    total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize));
  const canNext = last === undefined ? Boolean(hasMore) : page < last;
  if (page === 1 && !canNext) return null;
  const buttonClass =
    "rounded-sm border border-line-md px-3 py-1.5 text-text-2 hover:bg-white/5 disabled:opacity-40";
  return (
    <nav
      aria-label="Pages"
      className="mt-5 flex items-center justify-center gap-3 text-[12px]"
    >
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className={buttonClass}
      >
        Previous
      </button>
      <span className="font-mono text-text-3">
        {last === undefined ? page : `${page} / ${last}`}
      </span>
      <button
        type="button"
        disabled={!canNext}
        onClick={() => onPage(page + 1)}
        className={buttonClass}
      >
        Next
      </button>
    </nav>
  );
}

export const tableWrap =
  "overflow-x-auto rounded-lg border border-line bg-card";
export const thClass =
  "whitespace-nowrap border-b border-line bg-card-alt px-3.5 py-2.5 text-left text-[11px] font-medium tracking-[0.5px] text-text-3 uppercase";
export const tdClass =
  "border-b border-white/[0.04] px-3.5 py-[11px] text-[12px] text-text-2";
export const inputClass =
  "rounded-sm border border-line-md bg-surface px-2.5 py-[5px] text-[12px] text-text-1 outline-none placeholder:text-text-3 focus:border-accent";
export const primaryButton =
  "rounded-sm bg-accent px-3.5 py-[7px] text-[12px] font-medium text-accent-text hover:opacity-85 disabled:opacity-50";
export const ghostButton =
  "rounded-sm border border-line-md px-3 py-[5px] text-[12px] text-text-2 hover:bg-white/5 hover:text-text-1 disabled:opacity-50";
