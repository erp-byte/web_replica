"use client";

// SFG / WIP module landing — three catalogue/inventory screens backed by the
// production SFG endpoints. Mirrors modules/production/page.tsx's card grid.

import { useRouter } from "next/navigation";
import { SfgShell } from "./shell";

type Card = { title: string; description: string; route: string };

const CARDS: Card[] = [
  {
    title: "SFG Master",
    description: "The semi-finished-goods catalogue — code, name, recipe family, create-WIP operation, and where-used fan-out.",
    route: "/modules/sfg/master",
  },
  {
    title: "Where Used",
    description: "Reverse index: enter an SFG#### and see every finished good that consumes it, with the consuming stage.",
    route: "/modules/sfg/where-used",
  },
  {
    title: "WIP Stock",
    description: "On-hand semi-finished stock by SFG#### — total kg, batch count, oldest lot, and floor location.",
    route: "/modules/sfg/wip-stock",
  },
  {
    title: "Routing Gaps",
    description: "Reconciliation queue: unrouted FG articles grouped by product family — review the suggested Process Category and apply to route them.",
    route: "/modules/sfg/routing-gaps",
  },
];

export default function SfgLandingPage() {
  const router = useRouter();
  return (
    <SfgShell
      title="SFG / WIP"
      subtitle="Semi-finished goods catalogue, where-used, and work-in-progress stock."
      crumb="Overview"
      backHref="/modules"
      backLabel="modules"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {CARDS.map((c) => (
          <button
            key={c.route}
            onClick={() => router.push(c.route)}
            className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-1">{c.title}</h3>
            <p className="text-[12px] text-[var(--text-secondary)]">{c.description}</p>
          </button>
        ))}
      </div>
    </SfgShell>
  );
}
