import type { NavIcon as IconName } from "@/lib/ui/nav";

const PATHS: Record<IconName, React.ReactNode> = {
  overview: (
    <>
      <rect x="1" y="1" width="6" height="6" rx="1.5" />
      <rect x="9" y="1" width="6" height="6" rx="1.5" />
      <rect x="1" y="9" width="6" height="6" rx="1.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" />
    </>
  ),
  map: (
    <>
      <path d="M8 1C5.24 1 3 3.24 3 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5z" />
      <circle cx="8" cy="6" r="1.5" />
    </>
  ),
  acoustic: (
    <polyline
      points="1,12 4,6 7,10 10,4 13,8 15,5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  classification: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <path d="M5 8h6M5 5.5h6M5 10.5h4" strokeLinecap="round" />
    </>
  ),
  alerts: (
    <>
      <path d="M8 1.5L2 13.5h12L8 1.5z" strokeLinejoin="round" />
      <path d="M8 6v3.5M8 11v.5" strokeLinecap="round" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.5 2" strokeLinecap="round" />
    </>
  ),
  health: (
    <path
      d="M1 8h3l2-5 3 9 2-4h4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
        strokeLinecap="round"
      />
    </>
  ),
};

export function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-[15px] w-[15px] shrink-0"
    >
      {PATHS[name]}
    </svg>
  );
}
