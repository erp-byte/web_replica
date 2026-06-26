// Shared client-side constants. Each value lives in exactly one place so a
// product decision (e.g. "show 50 rows per page, not 100") is a one-line
// change that propagates to every consumer.
//
// Keep this file purely numeric / string scalars. Anything that touches
// React, the API client, or storage belongs in a hook or lib module.

// Job-card listing page size. Mirrors the server-side `page_size` default
// on /api/v1/production/job-cards-v2 (100) so the UI fills a page in one
// request without exceeding the backend's `le=500` cap.
export const JC_LIST_PAGE_SIZE = 100;

// Search debounce on the listing toolbar. Matches the legacy frontend
// timing (a 300 ms hold-time keeps the search responsive without thrashing
// the server while the operator is still typing).
export const SEARCH_DEBOUNCE_MS = 300;

// Number of per-sample rows in the Quality → Weight Checks grid. Mirrors
// QualityFragment.NUM_SAMPLES on Android. Changing this on the web alone
// would let operators record N samples that the Android form doesn't
// expose — so keep it in lock-step.
export const WEIGHT_SAMPLE_COUNT = 20;

// Accounting Summary tolerance when deciding "Is Balanced?" — 50 g around
// rmIssuedKg minus accountedKg. Below this the difference is treated as
// rounding noise; at or above we surface a red "No". Matches the operator
// expectation on the floor: weighing scales repeat to within ~30-40 g per
// batch, so 50 g is a noise floor rather than a strict allowance.
export const BALANCE_TOLERANCE_KG = 0.05;
