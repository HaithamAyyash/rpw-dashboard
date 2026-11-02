import { Suspense } from "react";
import { Acoustic } from "@/components/Acoustic";

export default function Page() {
  return (
    <Suspense>
      <Acoustic />
    </Suspense>
  );
}
