// Sample requisition list cache — tab-scoped (sessionStorage) so filters +
// fetched rows survive a round-trip into the detail page and back. Mirrors
// lib/jc-list-cache.ts; auto-drained on sign-out.

import { registerOnSignOut } from "./auth";
import type { Requisition } from "./sample";

export interface SampleListCache {
  status: string;
  sampleType: string;
  warehouse: string;
  rows: Requisition[];
  scrollY: number;
}

const KEY = "sample-list-state";

export function loadSampleListCache(): SampleListCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SampleListCache) : null;
  } catch {
    return null;
  }
}

export function saveSampleListCache(state: SampleListCache): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota / disabled — listing still works, back-nav just refetches */
  }
}

export function clearSampleListCache(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  registerOnSignOut(clearSampleListCache);
}
