import { notFound } from "next/navigation";
import { NAV_SECTIONS } from "@/lib/ui/nav";

type Props = { params: Promise<{ section: string }> };

/** Screens from later milestones, so the navigation works meanwhile. */
export default async function SectionPage({ params }: Props) {
  const { section } = await params;
  const item = NAV_SECTIONS.flatMap((s) => s.items).find(
    (i) => i.path === section,
  );
  if (!item) notFound();
  return (
    <div className="px-6 py-10 text-center text-[13px] text-text-3">
      <p className="mb-1 text-[14px] font-medium text-text-1">{item.label}</p>
      <p>This screen isn&apos;t built yet.</p>
    </div>
  );
}
