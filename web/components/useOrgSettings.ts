"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, type OrgSettings } from "@/lib/ui/api";
import { useCurrentOrg } from "./OrgContext";

export function useOrgSettings() {
  const org = useCurrentOrg();
  return useQuery({
    queryKey: ["org", org.org_id],
    queryFn: () => apiGet<OrgSettings>(`/orgs/${org.org_id}`),
  });
}
