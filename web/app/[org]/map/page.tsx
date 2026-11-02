import { Suspense } from "react";
import { SensorMap } from "@/components/SensorMap";

export default function Page() {
  return (
    <Suspense>
      <SensorMap />
    </Suspense>
  );
}
