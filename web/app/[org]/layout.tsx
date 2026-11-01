import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { loadMemberships, loadUser } from "@/lib/auth/current";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

type Props = { children: ReactNode; params: Promise<{ org: string }> };

export default async function OrgLayout({ children, params }: Props) {
  const { org: slug } = await params;
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  const user = claims ? await loadUser(claims) : null;
  if (!user) redirect("/login");

  const memberships = await loadMemberships(user.user_id);
  const current = memberships.find((m) => m.slug === slug);
  // Same result for another organization's page and one that doesn't exist.
  if (!current) redirect("/");

  return (
    <Shell org={current} memberships={memberships} userName={user.name}>
      {children}
    </Shell>
  );
}
