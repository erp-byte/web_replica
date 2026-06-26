// Shared presentational helpers for the Sample module. Underscore-prefixed so
// the Next App Router does NOT treat it as a route. Imported by the queue,
// wizard, and detail pages.

export const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:                 { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  SUBMITTED:             { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" },
  BH_APPROVED:           { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  BH_REJECTED:           { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  ON_HOLD:               { bg: "#fef9c3", fg: "#854d0e", ring: "#fde68a" },
  IN_PRODUCTION:         { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a" },
  PACKING:               { bg: "#f5f3ff", fg: "#6d28d9", ring: "#ddd6fe" },
  READY_FOR_DISPATCH:    { bg: "#ecfeff", fg: "#0e7490", ring: "#a5f0fc" },
  INTERNALLY_DISPATCHED: { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  PARTIALLY_CONVERTED:   { bg: "#fff7ed", fg: "#c2410c", ring: "#fed7aa" },
  GATE_PASS_ISSUED:      { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" },
  CLOSED:                { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
  CANCELLED:             { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

export const TYPE_LABEL: Record<string, string> = {
  BASIS_RM: "Basis RM", BASIS_FG: "Basis FG", NPD: "NPD", INTERNAL: "Internal", TRIAL: "Trial",
};

export function StatusPill({ status }: { status?: string | null }) {
  const s = STATUS_STYLES[status ?? ""] ?? STATUS_STYLES.DRAFT;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}

// NPD review status — the NPD queue/detail surface only 3 review states:
//   Pending  ← DRAFT, SUBMITTED (the default on create / awaiting review)
//   Hold     ← ON_HOLD (the Hold pill's tooltip shows the reason)
//   Accepted ← BH_APPROVED and everything downstream (in production … closed)
// CANCELLED / BH_REJECTED are terminal negatives, shown as "Cancelled".
export type NpdReviewStatus = "PENDING" | "HOLD" | "ACCEPTED" | "CANCELLED";

// Filter buckets (the 3 active states) → the underlying statuses they cover.
export const NPD_STATUS_FILTERS: { value: NpdReviewStatus; label: string; statuses: string[] }[] = [
  { value: "PENDING", label: "Pending", statuses: ["DRAFT", "SUBMITTED"] },
  { value: "HOLD", label: "Hold", statuses: ["ON_HOLD"] },
  {
    value: "ACCEPTED", label: "Accepted",
    statuses: ["BH_APPROVED", "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH",
      "INTERNALLY_DISPATCHED", "PARTIALLY_CONVERTED", "GATE_PASS_ISSUED", "CLOSED"],
  },
];

export function npdReviewStatus(raw?: string | null): NpdReviewStatus {
  switch (raw) {
    case "ON_HOLD": return "HOLD";
    case "CANCELLED":
    case "BH_REJECTED": return "CANCELLED";
    case "BH_APPROVED":
    case "IN_PRODUCTION":
    case "PACKING":
    case "READY_FOR_DISPATCH":
    case "INTERNALLY_DISPATCHED":
    case "PARTIALLY_CONVERTED":
    case "GATE_PASS_ISSUED":
    case "CLOSED": return "ACCEPTED";
    default: return "PENDING";   // DRAFT, SUBMITTED, anything else
  }
}

const NPD_STATUS_STYLES: Record<NpdReviewStatus, { bg: string; fg: string; ring: string; label: string }> = {
  PENDING:   { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3", label: "Pending" },
  HOLD:      { bg: "#fef9c3", fg: "#854d0e", ring: "#fde68a", label: "Hold" },
  ACCEPTED:  { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1", label: "Accepted" },
  CANCELLED: { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb", label: "Cancelled" },
};

// Simplified NPD status pill. For a HOLD, hovering shows the reason.
export function NpdStatusPill({ status, holdReason }: { status?: string | null; holdReason?: string | null }) {
  const key = npdReviewStatus(status);
  const s = NPD_STATUS_STYLES[key];
  const title = key === "HOLD" && holdReason ? `On hold — ${holdReason}` : undefined;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
      title={title}
    >
      {s.label}{key === "HOLD" && holdReason ? " ⓘ" : ""}
    </span>
  );
}

// Standalone NPD development job-card statuses (own vocabulary, own palette).
export const DEV_JC_STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:          { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  IN_DEVELOPMENT: { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a" },
  CLOSED:         { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" },
  CANCELLED:      { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

export function DevJcStatusPill({ status }: { status?: string | null }) {
  const s = DEV_JC_STATUS_STYLES[status ?? ""] ?? DEV_JC_STATUS_STYLES.DRAFT;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}

// RM Issue / Collection Form (Document 015) statuses.
export const RM_FORM_STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:     { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  SUBMITTED: { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" },
  APPROVED:  { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  ISSUED:    { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  CLOSED:    { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" },
  CANCELLED: { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

export function RmFormStatusPill({ status }: { status?: string | null }) {
  const s = RM_FORM_STATUS_STYLES[status ?? ""] ?? RM_FORM_STATUS_STYLES.DRAFT;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}
