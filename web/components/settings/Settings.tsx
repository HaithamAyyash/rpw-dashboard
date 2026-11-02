"use client";

import { ClusterSettings } from "./ClusterSettings";
import { MemberSettings } from "./MemberSettings";
import { NodeSettings } from "./NodeSettings";
import { OrganizationSettings } from "./OrganizationSettings";

export function Settings() {
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <OrganizationSettings />
      <MemberSettings />
      <ClusterSettings />
      <NodeSettings />
    </div>
  );
}
