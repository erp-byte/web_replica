"use client";

// Purchase module landing. Mirrors production/page.tsx card pattern.
// PO Upload is the purchase entry point on the web.

import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "./_chrome";

type SubModule = { title: string; description: string; route: string };

const SUB_MODULES: SubModule[] = [
  { title: "PO Upload", description: "Upload a PO workbook (.xlsx), preview SKU matches and duplicates, then commit. Browse, filter, and export existing purchase orders.", route: "/modules/purchase/po-creation" },
  { title: "Material In", description: "Browse received purchase orders by article and send arrival intimations.", route: "/modules/purchase/material-in" },
];

export default function PurchaseLandingPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();

  return (
    <PurchaseChrome title="Purchase">
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Purchase</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Upload, review, filter, and export purchase orders.
        </p>
      </div>
      {!isAdmin ? (
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Purchase module. Ask an administrator to grant you access, or switch to a different account.
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
    </PurchaseChrome>
  );
}
