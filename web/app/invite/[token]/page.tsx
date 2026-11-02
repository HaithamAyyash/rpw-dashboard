"use client";

import Image from "next/image";
import Link from "next/link";
import { use, useEffect, useState, type FormEvent } from "react";

type Invite = { org_name: string; email: string; account_exists: boolean };

const field =
  "w-full rounded-sm border border-line-md bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-accent";

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [invite, setInvite] = useState<Invite | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/invites/${token}`)
      .then((response) => (response.ok ? response.json() : null))
      .then(setInvite)
      .catch(() => setInvite(null));
  }, [token]);

  async function accept(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/invites/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        // A full page load on purpose, so the new organization is loaded fresh.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/");
        return;
      }
      const json = await response.json().catch(() => null);
      if (json?.error?.code === "login_required") setNeedsLogin(true);
      setError(
        json?.error?.message ?? "Couldn't accept the invite. Please try again.",
      );
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(false);
  }

  function submitNew(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    accept({ name: form.get("name"), password: form.get("password") });
  }

  const button =
    "mt-4 w-full rounded-sm bg-accent px-4 py-2 text-[12px] font-medium text-accent-text hover:opacity-85 disabled:opacity-50";

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-card p-6">
        <Image
          src="/nakhel_logo.jpg"
          alt="NAKHEL"
          width={92}
          height={154}
          priority
          className="mx-auto mb-5 rounded-sm"
        />
        {invite === undefined && (
          <div className="h-24 animate-pulse rounded-md bg-white/5" />
        )}
        {invite === null && (
          <>
            <h1 className="mb-1 text-[15px] font-medium">
              This invite isn&apos;t valid
            </h1>
            <p className="text-[13px] text-text-3">
              It may have expired or already been used. Ask an owner for a new
              one.
            </p>
          </>
        )}
        {invite && (
          <>
            <h1 className="mb-1 text-[15px] font-medium">
              Join {invite.org_name}
            </h1>
            <p className="mb-4 text-[13px] text-text-3">For {invite.email}</p>
            {invite.account_exists ? (
              <>
                {!needsLogin && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => accept({})}
                    className={button}
                  >
                    Accept invite
                  </button>
                )}
                {needsLogin && (
                  <Link
                    href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
                    className={`${button} block text-center`}
                  >
                    Log in to accept
                  </Link>
                )}
              </>
            ) : (
              <form onSubmit={submitNew}>
                <label
                  className="mb-1 block text-[11px] text-text-2"
                  htmlFor="name"
                >
                  Your name
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  autoComplete="name"
                  className={field}
                />
                <label
                  className="mt-3 mb-1 block text-[11px] text-text-2"
                  htmlFor="password"
                >
                  Choose a password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                  className={field}
                />
                <p className="mt-1 text-[11px] text-text-3">
                  At least 10 characters.
                </p>
                <button type="submit" disabled={busy} className={button}>
                  {busy ? "Joining…" : "Create account and join"}
                </button>
              </form>
            )}
            {error && !needsLogin && (
              <p role="alert" className="mt-3 text-[12px] text-danger">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
