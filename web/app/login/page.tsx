"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      if (response.ok) {
        const next =
          new URLSearchParams(window.location.search).get("next") ?? "/";
        // Only same-site paths, so a crafted link can't send someone elsewhere after login.
        const safe =
          next.startsWith("/") && !next.startsWith("//") ? next : "/";
        // A full page load on purpose: it drops anything cached from the previous session.
        window.location.assign(safe);
        return;
      }
      setError(
        response.status === 401
          ? "Wrong email or password."
          : "Couldn't log in. Please try again.",
      );
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(false);
  }

  const field =
    "w-full rounded-sm border border-line-md bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-accent";

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-line bg-card p-6"
      >
        <Image
          src="/nakhel_logo.jpg"
          alt="NAKHEL"
          width={92}
          height={154}
          priority
          className="mx-auto mb-5 rounded-sm"
        />
        <label className="mb-1 block text-[11px] text-text-2" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={field}
        />
        <label
          className="mt-3 mb-1 block text-[11px] text-text-2"
          htmlFor="password"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={field}
        />
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-sm bg-accent px-4 py-2 text-[12px] font-medium text-accent-text hover:opacity-85 disabled:opacity-50"
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
    </main>
  );
}
