"use client";

// QC module landing. Card grid for QC sub-modules.

import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { QcChrome } from "./_chrome";

type SubModule = { title: string; description: string; route: string };

const SUB_MODULES: SubModule[] = [
  {
    title: "Inward Inspection",
    description:
      "QC inspection of inward consignments — start from a dock-arrival intimation, capture readings, attach a COA, and finalise the verdict.",
    route: "/modules/qc/inward-inspection",
  },
  {
    title: "NCR",
    description:
      "Non-conformance reports — raise from a failed inspection or manually, capture failed parameters, disposition, supplier CAPA, and close out.",
    route: "/modules/qc/ncr",
  },
  {
    title: "Parameters",
    description:
      "RM-check parameter catalogue — the master list of QC parameters by group, with units, value types, and spec notes.",
    route: "/modules/qc/parameters",
  },
];

export default function QcLandingPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();

  return (
    <QcChrome title="QC">
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Quality Control</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Inspect inward goods, capture readings, and gate stock release on QC outcomes.
        </p>
      </div>
      {!isAdmin ? (
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the QC module. Ask an administrator to grant you access, or switch to a different account.
        </section>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SUB_MODULES.map((m) => (
            <button
              key={m.route}
              onClick={() => router.push(m.route)}
              className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
            >
              <h2 className="text-[14px] font-semibold text-[var(--text-primary)] mb-1">{m.title}</h2>
              <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
            </button>
          ))}
        </div>
      )}
    </QcChrome>
  );
}
