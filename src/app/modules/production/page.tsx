"use client";

// Production module landing. Surfaces the production sub-modules the same
// way the modules grid surfaces top-level modules. Mirrors the sidebar
// taxonomy in frontend_replica/src/modules/production/* without forcing
// the operator into a left-nav layout — each card links to a route that
// is either implemented (SO Creation, Job Cards) or a stub placeholder.

import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { BackLink } from "@/components/BackLink";

type SubModule = {
  title: string;
  description: string;
  group: "Sales" | "Planning" | "Execution" | "Inventory" | "Monitoring";
  route: string;
  implemented: boolean;
  // Toggle to remove a module from the landing without deleting the entry —
  // lets us bring features back without re-deriving the description / route.
  hidden?: boolean;
};

// Orders + SO Fulfillment were removed entirely (they're covered by Planning).
// The `hidden: true` entries below stay in the data so flipping the flag
// brings them back without re-deriving the metadata.
const SUB_MODULES: SubModule[] = [
  { group: "Sales",      title: "SO Creation",        description: "Upload Sales Register, create or update Sales Orders, reconcile GST.",                                                                                  route: "/modules/production/so-creation", implemented: true },
  { group: "Planning",   title: "Planning",           description: "Track open SO demand by entity, filter by customer / SO / article, set deadlines, and bundle selected articles into a plan.",                          route: "/modules/production/planning",    implemented: true },
  { group: "Planning",   title: "Plan List",          description: "Review draft / approved / executed plans · approve drafts or cancel them with a reason.",                                                              route: "/modules/production/plan-list",   implemented: true },
  { group: "Planning",   title: "Plan Builder",       description: "Interactive plan editor with capacity and BOM constraints.",                                                                                            route: "/modules/production/plan-builder",implemented: false, hidden: true },
  { group: "Execution",  title: "Job Cards",          description: "Track job-card lifecycle across the factory floor.",                                                                                                    route: "/modules/job-card",               implemented: true },
  { group: "Execution",  title: "Team Dashboard",     description: "Per-team view of in-progress and pending job cards.",                                                                                                   route: "/modules/production/team",        implemented: false, hidden: true },
  { group: "Execution",  title: "Floor Dashboard",    description: "Per-floor utilisation, output, and material status.",                                                                                                  route: "/modules/production/floor",       implemented: false, hidden: true },
  { group: "Execution",  title: "Store Dashboard",    description: "Warehouse-side allocation and dispatch summary.",                                                                                                      route: "/modules/production/store",       implemented: false, hidden: true },
  { group: "Inventory",  title: "Indents",            description: "Raise and track RM / PM indents to the warehouse.",                                                                                                    route: "/modules/production/indents",     implemented: false, hidden: true },
  { group: "Inventory",  title: "Production Indents", description: "Per-plan indent generation and acknowledgement.",                                                                                                      route: "/modules/production/prod-indents",implemented: false, hidden: true },
  { group: "Monitoring", title: "QC Dashboard",       description: "Aggregate QC outcomes and pending sign-offs.",                                                                                                         route: "/modules/production/qc",          implemented: false, hidden: true },
  { group: "Monitoring", title: "Alerts",             description: "Open alerts requiring operator attention.",                                                                                                            route: "/modules/production/alerts",      implemented: false, hidden: true },
];

const GROUPS = ["Sales", "Planning", "Execution", "Inventory", "Monitoring"] as const;

export default function ProductionLandingPage() {
  const router = useRouter();
  const initial = useUserInitial();
  useRequireAuth(router.replace);

  function open(m: SubModule) {
    if (m.implemented) router.push(m.route);
    else alert(`"${m.title}" is not yet implemented on the web. Use the Android or Electron client for now.`);
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <span className="text-white">Production</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile"
          title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules" label="modules" />
        </div>
        <div className="mb-6">
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Production</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            SO creation, planning, execution, and floor-side dashboards.
          </p>
        </div>

        {GROUPS.map((group) => {
          // Hide flagged entries; drop the whole section when nothing visible
          // remains in it (e.g. Inventory now has every entry hidden).
          const items = SUB_MODULES.filter((m) => m.group === group && !m.hidden);
          if (items.length === 0) return null;
          return (
            <section key={group} className="mb-8">
              <h2 className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-secondary)] mb-3">
                {group}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((m) => (
                  <button
                    key={m.route}
                    onClick={() => open(m)}
                    className={[
                      "text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition",
                      m.implemented
                        ? "hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
                        : "opacity-60",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{m.title}</h3>
                      {!m.implemented ? (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-sm bg-[var(--surface-disabled)] text-[var(--text-muted)]">
                          Soon
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
