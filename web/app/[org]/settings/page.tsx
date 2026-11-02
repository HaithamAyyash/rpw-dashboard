import { Suspense } from "react";
import { Settings } from "@/components/settings/Settings";

export default function Page() {
  return (
    <Suspense>
      <Settings />
    </Suspense>
  );
}
