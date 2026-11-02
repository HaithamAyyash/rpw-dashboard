import { Suspense } from "react";
import { AlertLog } from "@/components/AlertLog";

export default function Page() {
  return (
    <Suspense>
      <AlertLog />
    </Suspense>
  );
}
