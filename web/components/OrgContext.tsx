"use client";

import { createContext, useContext } from "react";
import type { Membership } from "@/lib/auth/current";

const OrgContext = createContext<Membership | null>(null);

export const OrgProvider = OrgContext.Provider;

export function useCurrentOrg(): Membership {
  const org = useContext(OrgContext);
  if (!org) throw new Error("useCurrentOrg needs an OrgProvider");
  return org;
}
