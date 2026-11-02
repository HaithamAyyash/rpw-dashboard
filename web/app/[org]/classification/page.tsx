import { Suspense } from "react";
import { Classification } from "@/components/Classification";

export default function Page() {
  return (
    <Suspense>
      <Classification />
    </Suspense>
  );
}
