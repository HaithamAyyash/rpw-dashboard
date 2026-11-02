import { Suspense } from "react";
import { Health } from "@/components/Health";

export default function Page() {
  return (
    <Suspense>
      <Health />
    </Suspense>
  );
}
