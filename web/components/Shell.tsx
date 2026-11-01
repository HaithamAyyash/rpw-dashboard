"use client";

import type { ReactNode } from "react";
import { Suspense } from "react";
import type { Membership } from "@/lib/auth/current";
import { OrgProvider } from "./OrgContext";
import { Providers } from "./Providers";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

type Props = {
  org: Membership;
  memberships: Membership[];
  userName: string;
  children: ReactNode;
};

export function Shell({ org, memberships, userName, children }: Props) {
  return (
    <Providers>
      <OrgProvider value={org}>
        <div className="flex min-h-screen">
          <Suspense>
            <Sidebar />
          </Suspense>
          <div className="flex min-w-0 flex-1 flex-col">
            <Suspense>
              <TopBar memberships={memberships} userName={userName} />
            </Suspense>
            <main className="flex-1 px-4 py-6 md:px-7">{children}</main>
          </div>
        </div>
      </OrgProvider>
    </Providers>
  );
}
