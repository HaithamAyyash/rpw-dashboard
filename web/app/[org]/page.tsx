import { Suspense } from "react";
import { Overview } from "@/components/Overview";

export default function OverviewPage() {
  return (
    <Suspense>
      <Overview />
    </Suspense>
  );
}
