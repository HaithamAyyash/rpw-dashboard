"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Filters live in the URL, so a filtered view can be reloaded and shared. */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParams(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  return {
    get: (key: string) => searchParams.get(key) ?? "",
    page: Math.max(1, Number(searchParams.get("page")) || 1),
    zone: searchParams.get("zone") ?? "",
    setParams,
  };
}
