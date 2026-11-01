import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadMemberships, loadUser } from "@/lib/auth/current";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/** After login: one organization goes straight to it, several get a picker. */
export default async function Home() {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  const user = claims ? await loadUser(claims) : null;
  if (!user) redirect("/login");

  const memberships = await loadMemberships(user.user_id);
  if (memberships.length === 1) redirect(`/${memberships[0]!.slug}`);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-card p-6">
        <h1 className="mb-1 text-[15px] font-medium">Choose an organization</h1>
        {memberships.length === 0 ? (
          <p className="text-[13px] text-text-3">
            Your account doesn&apos;t belong to any organization yet. Ask an
            owner for an invite.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {memberships.map((m) => (
              <li key={m.org_id}>
                <Link
                  href={`/${m.slug}`}
                  className="block rounded-sm border border-line-md px-4 py-2.5 text-[13px] text-text-1 hover:bg-card-alt"
                >
                  {m.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
