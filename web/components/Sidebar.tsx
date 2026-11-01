"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { NAV_SECTIONS } from "@/lib/ui/nav";
import { NavIcon } from "./NavIcon";
import { useCurrentOrg } from "./OrgContext";

/** Collapses to icons below 900 px, for tablets, as the prototype does. */
export function Sidebar() {
  const org = useCurrentOrg();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const zone = searchParams.get("zone");
  const suffix = zone ? `?zone=${encodeURIComponent(zone)}` : "";

  return (
    <aside className="sticky top-0 flex h-screen w-[60px] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface min-[900px]:w-[220px]">
      <div className="flex justify-center border-b border-line px-2.5 py-3">
        <Image
          src="/nakhel_logo.jpg"
          alt="NAKHEL logo"
          width={84}
          height={141}
          priority
          className="h-auto w-10 rounded-sm min-[900px]:w-[84px]"
        />
      </div>
      {NAV_SECTIONS.map((section) => (
        <nav
          key={section.label}
          aria-label={section.label}
          className="px-3 pt-3.5 pb-1.5"
        >
          <div className="mb-1.5 hidden px-2 text-[10px] tracking-[1px] text-text-3 uppercase min-[900px]:block">
            {section.label}
          </div>
          {section.items.map((item) => {
            const href = `/${org.slug}${item.path ? `/${item.path}` : ""}`;
            const active = pathname === href;
            return (
              <Link
                key={item.label}
                href={`${href}${suffix}`}
                title={item.label}
                aria-current={active ? "page" : undefined}
                className={`mb-0.5 flex items-center justify-center gap-2.5 rounded-sm p-2.5 text-[13px] transition-colors min-[900px]:justify-start ${
                  active
                    ? "bg-accent-dim text-accent"
                    : "text-text-2 hover:bg-white/5 hover:text-text-1"
                }`}
              >
                <NavIcon name={item.icon} />
                <span className="hidden min-[900px]:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      ))}
      <div className="mt-auto hidden border-t border-line p-3.5 min-[900px]:block">
        <div className="rounded-sm border border-accent/15 bg-accent-dim px-3 py-2.5">
          <div className="truncate text-[12px] font-medium text-accent">
            {zone ?? "All zones"}
          </div>
          <div className="truncate text-[11px] text-text-3">{org.name}</div>
        </div>
      </div>
    </aside>
  );
}
