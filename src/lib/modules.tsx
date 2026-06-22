// Mirrors com.candor.ims.ui.modules.ModulesActivity#MODULES — kept hardcoded
// because the server's /api/v1/auth/modules endpoint is admin-only.

import type { ComponentType, SVGProps } from "react";

export interface ModuleItem {
  title: string;
  description: string;
  badge: string;
  stat: string;
  route: string;
  implemented?: boolean;
  // Hide the tile from non-admins on /modules AND have each module's root
  // page inline-gate itself for direct navigation. Matches the existing
  // Admin tile's pattern (route === "admin" was previously hardcoded in
  // /modules/page.tsx; folded into the flag so the rule lives in one place).
  adminOnly?: boolean;
  // When set, the tile/route is visible to admins OR any user holding one of
  // these role codes (and hidden from everyone else). Distinct from adminOnly,
  // which is admin-only. Honored by /modules and the module's route guard.
  allowedRoles?: string[];
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

function PurchaseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H7" />
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="17" cy="20" r="1.4" />
    </svg>
  );
}

function QcIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function ProductionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 20V10l5 3V10l5 3V8l8 4v8z" />
      <path d="M3 20h18" />
      <path d="M7 17h2M12 17h2M17 17h2" />
    </svg>
  );
}

function JobCardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v3h8V3" />
      <path d="M8 11h8" />
      <path d="M8 15h6" />
      <path d="M8 19h4" />
    </svg>
  );
}

function SampleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v6.5L5.5 17a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9.5V3" />
      <path d="M8 14h8" />
    </svg>
  );
}

function NpdDevIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v6L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3" />
      <path d="M7 14h10" />
      <circle cx="10" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="18" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TransferIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 8h13" />
      <path d="M14 5l3 3-3 3" />
      <path d="M20 16H7" />
      <path d="M10 13l-3 3 3 3" />
    </svg>
  );
}

function AdminIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function SfgIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.27 6.96 12 12l8.73-5.04" />
      <path d="M12 22V12" />
    </svg>
  );
}

export const MODULES: ModuleItem[] = [
  {
    title: "Purchase",
    description:
      "Manage Purchase Orders, receive materials, track vendor deliveries, and handle box-level inventory with thermal label printing.",
    badge: "Core",
    stat: "PO Creation & Receiving",
    route: "purchase",
    implemented: true,
    adminOnly: true,
    Icon: PurchaseIcon,
  },
  {
    title: "QC",
    description:
      "Inward inspection, readings capture, COA, and verdict — quality gating for incoming material.",
    badge: "Core",
    stat: "Inspect & decide",
    route: "qc",
    implemented: true,
    adminOnly: true,
    Icon: QcIcon,
  },
  {
    title: "Production",
    description:
      "Plan production, manage job cards, track fulfillment, handle MRP, indents, inventory, and day-end operations.",
    badge: "Core",
    stat: "Full Production Suite",
    route: "production",
    implemented: true,
    Icon: ProductionIcon,
  },
  {
    title: "Job Card",
    description:
      "Create, issue, and track shop-floor job cards. Record operation status, output, downtime, and operator entries against active production plans.",
    badge: "Shop floor",
    stat: "Track & manage job cards",
    route: "job-card",
    implemented: true,
    Icon: JobCardIcon,
  },
  {
    title: "SFG / WIP",
    description:
      "Semi-finished goods catalogue — browse the SFG master, reverse-lookup where each SFG is used across finished goods, and view work-in-progress stock on hand.",
    badge: "Shop floor",
    stat: "Master · Where-Used · WIP Stock",
    route: "sfg",
    implemented: true,
    Icon: SfgIcon,
  },
  {
    title: "Sample",
    description:
      "Raise and track sample requisitions (Basis RM, Basis FG, NPD, Internal), run approvals, issue outward & gate passes, and convert internal samples to external dispatch.",
    badge: "Core",
    stat: "Requisitions · Approvals · Gate passes",
    route: "sample",
    implemented: true,
    adminOnly: true,
    Icon: SampleIcon,
  },
  {
    title: "NPD Development",
    description:
      "New product development — raise NPD / customer-trial requests, run NPD review (approve / reject / hold), and build trial recipes into live BOMs via development job cards.",
    badge: "R&D",
    stat: "Requests · Review · Dev job cards",
    route: "npd-development",
    implemented: true,
    allowedRoles: ["npd_team", "business_head", "inventory_manager"],
    Icon: NpdDevIcon,
  },
  {
    title: "Inter-Unit Transfer",
    description:
      "Raise transfer requests, dispatch stock between units (warehouse & cold), receive against GRN, and track in-transit pending stock across CFPL/CDPL.",
    badge: "Logistics",
    stat: "Requests · Dispatch · Receive · In-Transit",
    route: "transfer",
    implemented: true,
    adminOnly: true,
    Icon: TransferIcon,
  },
  {
    title: "Admin",
    description:
      "Manage users, assign roles, edit factory / floor scope, and curate the permission catalog. Admin role required.",
    badge: "Admin",
    stat: "Users · Roles · Permissions",
    route: "admin",
    implemented: true,
    adminOnly: true,
    Icon: AdminIcon,
  },
];
