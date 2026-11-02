"use client";

import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/ui/api";
import { ghostButton } from "../States";

export function Card({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-line bg-card p-5"
    >
      <h2 className="text-[14px] font-medium text-text-1">{title}</h2>
      {note && <p className="mt-0.5 text-[12px] text-text-3">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-text-2">
      {label}
      {children}
    </label>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const details = error instanceof ApiError ? error.details : undefined;
  return (
    <div role="alert" className="mt-2 text-[12px] text-danger">
      <p>{error instanceof Error ? error.message : "Something went wrong"}</p>
      {details && details.length > 0 && (
        <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-4">
          {details.slice(0, 50).map((d, i) => (
            <li key={i}>
              {d.line !== undefined
                ? `Line ${d.line}: `
                : d.path
                  ? `${d.path}: `
                  : ""}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A secret or link shown once, with a copy button. */
export function ShowOnce({
  title,
  warning,
  value,
  testId,
  onDone,
}: {
  title: string;
  warning: string;
  value: string;
  testId: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard needs https or localhost; the text can still be selected
    }
  }
  return (
    <div className="mb-4 rounded-md border border-accent/30 bg-accent-dim p-3.5">
      <p className="text-[13px] font-medium text-text-1">{title}</p>
      <p className="mb-2 text-[12px] text-text-2">{warning}</p>
      <code
        data-testid={testId}
        className="block rounded-sm bg-surface p-2 font-mono text-[11px] break-all text-text-1 select-all"
      >
        {value}
      </code>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={copy} className={ghostButton}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={onDone} className={ghostButton}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A form field for a number that may be left blank. */
export function optionalNumber(
  value: FormDataEntryValue | null,
): number | undefined {
  const text = String(value ?? "").trim();
  return text === "" ? undefined : Number(text);
}

export function optionalText(
  value: FormDataEntryValue | null,
): string | undefined {
  const text = String(value ?? "").trim();
  return text === "" ? undefined : text;
}
