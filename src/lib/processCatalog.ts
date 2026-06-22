// Canonical process catalog shared by the Planning page (per-card step
// editor) and the Plan List edit page (per-line step editor). One list,
// one matcher — adding a new process here makes it pickable in both
// places at once. Order matches the shop-floor sequence operators
// usually walk through, so the dropdown reads top-to-bottom like a
// real BOM.

export const PROCESS_OPTIONS: readonly string[] = [
  "Sorting",
  "Flavouring",
  "Packaging",
  "Bulk Packaging",
  "Blending",
  "Bar Forming",
  "Roasting",
  "De-seeding",  // legacy spelling "De-Seeding" maps to this via canonProcess
  "Blanching",
  "Slicing",
  "Dicing",
  "Slivering",
  "Chocolate",
  "Stuffing",
  "Enrobing",
  "Flow Wrap",
  "Master Carton",
  "Weighing",
  "Mixing",
  "Krugger",
  "X-ray",
  "Monocarton",
] as const;

// Normalise legacy spellings (e.g. "De-Seeding" → "De-seeding") so the
// dropdown highlights the right option for BOMs created before we
// standardised the catalog. Key-by-lowercase; preserves the canonical
// capitalisation when there's a match, else passes through unchanged
// so custom names survive intact.
export function canonProcess(name: string | null | undefined): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  const match = PROCESS_OPTIONS.find((p) => p.toLowerCase() === lower);
  return match ?? name;
}

// True when `name` exactly matches a canonical option (case-insensitive).
// Used by step-row dropdowns to decide whether to synthesise an extra
// "(custom)" option for legacy values.
export function isCanonicalProcess(name: string | null | undefined): boolean {
  if (!name) return false;
  return PROCESS_OPTIONS.some((p) => p.toLowerCase() === name.toLowerCase());
}

// Derive a stage token from a process_name. Mirrors the server-side
// helper in plan_v2.derive_stage_from_process so both ends agree:
//
//   "Sorting"     → "sorting"
//   "Bar Forming" → "bar_forming"
//   "De-seeding"  → "de-seeding"
//
// Used by the Plan / Plan-list edit dropdowns to populate stage
// alongside process_name when the operator picks from the catalog —
// keeps the row valid for the downstream job_card_v2.stage NOT NULL
// constraint without requiring a server round-trip to "fix" the row.
export function stageFromProcess(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.trim();
  if (!cleaned) return null;
  return cleaned.toLowerCase().replace(/ /g, "_");
}

// ── Process-category classification (Slice 2) ──────────────────────────────
// Client mirror of master_ingest.classify_route_steps. Each Process-Category
// token maps to a practical operation + a stage bucket. G2 LOCKED: Sorting =
// inline; Packaging family = terminal (Final FG). Matches on the LEADING token
// (text before "(") so "Roasting (Bulk Packaging" classifies like "Roasting".

export const STAGE_CREATE_WIP = "Create WIP";
export const STAGE_FINAL_FG = "Final FG";
export const STAGE_INLINE = "inline";

const _TRANSFORM_OPS: Record<string, string> = {
  "de-seeding": "De-Seeding",
  "deseeding": "De-Seeding",
  "blanching": "Blanch & Slice",
  "slicing/dicing/slivering": "Blanch & Slice",
  "slicing": "Blanch & Slice",
  "dicing": "Blanch & Slice",
  "slivering": "Blanch & Slice",
  "blending": "Blend & Form",
  "bar forming": "Blend & Form",
  "roasting": "Roasting",
  "flavouring": "Roast & Flavour/Salt",
  "salting": "Roast & Flavour/Salt",
  "stuffing": "Stuffing",
  "enrobing": "Enrobe / Choco-Coat",
  "chocolate": "Enrobe / Choco-Coat",
};
const _SEASONING = new Set(["flavouring", "salting"]);
const _TERMINAL = new Set([
  "packaging", "bulk packaging", "master carton", "mono carton", "monocarton",
  "flow wrap", "krugger", "x-ray", "xray", "weighing",
]);
const _INLINE = new Set(["sorting", "receiving"]);

function _canonToken(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().split("(")[0].trim();
}

export type ProcessClass = {
  practicalOperation: string | null;
  stageBucket: string | null;
  producesSfg: boolean;
};

// Classify an FG's ORDERED steps (combine-aware: Roasting + a seasoning token
// ⇒ the Roasting step becomes the combined "Roast & Flavour/Salt").
export function classifySteps(stepNames: (string | null | undefined)[]): ProcessClass[] {
  const canon = stepNames.map(_canonToken);
  const hasSeason = canon.some((t) => _SEASONING.has(t));
  return canon.map((t) => {
    // Object.hasOwn (not `t in`) so a token like "constructor"/"__proto__" can't
    // match an inherited prototype key — mirrors the Python dict's behaviour.
    if (Object.hasOwn(_TRANSFORM_OPS, t)) {
      const op = t === "roasting" && hasSeason ? "Roast & Flavour/Salt" : _TRANSFORM_OPS[t];
      return { practicalOperation: op, stageBucket: STAGE_CREATE_WIP, producesSfg: true };
    }
    if (_TERMINAL.has(t)) return { practicalOperation: "Packaging", stageBucket: STAGE_FINAL_FG, producesSfg: false };
    if (_INLINE.has(t)) return { practicalOperation: null, stageBucket: STAGE_INLINE, producesSfg: false };
    return { practicalOperation: null, stageBucket: null, producesSfg: false };
  });
}

// Single-token classification (no combine context). Prefer classifySteps when
// the full step list is available so the Roasting/seasoning combine applies.
export function classifyProcess(name: string | null | undefined): ProcessClass {
  return classifySteps([name])[0];
}
