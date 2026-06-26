// Listing state cache for /modules/purchase/po-creation. Mirrors
// lib/so-list-cache.ts: tab-scoped sessionStorage entry preserving filters,
// sort, pagination, and expanded rows. Drains on sign-out.

import { registerOnSignOut } from "./auth";
import { sessionLoad, sessionSave, sessionClear } from "./session-state";

const KEY = "po-creation.list-state";

export interface PoListCache {
  search: string;                 // → po_number_contains
  entity: "" | "cfpl" | "cdpl";
  dateFrom: string;
  dateTo: string;
  adv: {                          // the five advanced fields from po-view.js
    vendor_supplier_name_contains: string;
    order_reference_no_contains: string;
    narration_contains: string;
    supplier_id: string;
    voucher_type: string;
  };
  sort: string;                   // "<col>:<dir>"
  page: number;
  expanded: string[];             // transaction_no list
}

export function loadPoListCache(): PoListCache | null { return sessionLoad<PoListCache>(KEY); }
export function savePoListCache(v: PoListCache): void { sessionSave<PoListCache>(KEY, v); }
export function clearPoListCache(): void { sessionClear(KEY); }

if (typeof window !== "undefined") {
  registerOnSignOut(clearPoListCache);
}
