// Friendly error messages for the production API surface (JC lifecycle,
// batches, plans, fulfillment, SO updates). The backend returns either
// {error, message, details} (request_context middleware) or {detail:{...}}
// (FastAPI's HTTPException) — both shapes carry an error code + a
// contextual message. This helper parses both, picks the backend's own
// message when present, and prepends a short action verb so the operator
// sees "Cannot complete — Batch 2 is still open" instead of
// `{"error":"open_batch","message":"Batch 2 is still open…"}`.

export type ApiErrorDetail = {
  error?: string;
  message?: string;
  batch_id?: number | string;
  batch_number?: number | string;
  batch_date?: string;
  status?: string;
  current_status?: string;
  reason?: string;
  locked_reason?: string;
  yield_pct?: number | string;
  output_qty_kg?: number | string;
  rm_consumed_kg?: number | string;
};

/**
 * Friendly error message for any production-API failure.
 *
 * Accepts an Error (whose .message holds the raw response body), a plain
 * string, or anything else (stringified as a last resort). Returns a
 * human sentence — never raw JSON, never an empty string.
 */
export function friendlyApiError(raw: unknown): string {
  let rawText = "";
  let detail: ApiErrorDetail | null = null;
  if (raw instanceof Error) {
    rawText = raw.message;
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === "object") {
        // Two backend wrappers in play:
        //   1. request_context middleware → {error,message,details:{...}}
        //   2. raw FastAPI HTTPException → {detail:{...}}
        // Merge so a structured `details`/`detail` block can override
        // top-level fields without losing the top-level message.
        const p = parsed as Record<string, unknown>;
        const inner = (p.detail ?? p.details) as Record<string, unknown> | undefined;
        const merged: Record<string, unknown> = { ...p };
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          Object.assign(merged, inner);
        }
        if ("error" in merged || "message" in merged) {
          detail = merged as ApiErrorDetail;
        }
      }
    } catch {
      // Non-JSON body — fall through to rawText.
    }
  } else if (typeof raw === "string") {
    rawText = raw;
  } else if (raw != null) {
    rawText = String(raw);
  }
  if (!detail) {
    return rawText || "Unknown error";
  }
  const code = detail.error || "";
  const msg = detail.message;
  // The middleware (server_replica/app/core/middleware/request_context.py)
  // fills `message` with the generic HTTP status name ("Bad request",
  // "Not found", "Forbidden", "Conflict", "Validation failed", etc.)
  // when the raised HTTPException's detail dict has no explicit message
  // field. These are useless to operators — they don't tell you WHICH
  // 400 you hit. Treat them as no-message-from-backend so the default
  // branch falls through to `Server error: <code>` which at least
  // surfaces the actual error code.
  const GENERIC_STATUS_MESSAGES = new Set([
    "Bad request", "Authentication required", "Forbidden", "Not found",
    "Method not allowed", "Conflict", "Unsupported media type",
    "Validation failed", "Account locked", "Too many requests",
    "Internal server error",
  ]);
  const isGenericStatus = msg ? GENERIC_STATUS_MESSAGES.has(msg.trim()) : false;
  const fromBackend = msg && msg.trim() && !isGenericStatus ? msg : null;
  // Helper: action-verb prefix wrapping the backend's own message.
  const compose = (verb: string, fallback: string) =>
    fromBackend ? `Cannot ${verb} — ${fromBackend}` : `Cannot ${verb} — ${fallback}`;
  switch (code) {
    // ── Admin gates (R10 — applied to JC cancel + plan cancel/delete) ──
    case "admin_only":
      return fromBackend || "Only admin users can perform this action.";
    // ── JC lifecycle ────────────────────────────────────────────────
    case "open_batch":
      return compose(
        "complete",
        `Batch ${detail.batch_number ?? "?"} is still open. Close every batch before completing the job card.`,
      );
    case "open_shift":
      return compose("complete", "an active shift segment is still running. Stop the shift before completing.");
    case "open_segment_exists":
      return compose("start a new shift", "an earlier shift segment is still open. Stop it first.");
    case "unbalanced":
      return compose(
        "complete",
        "accounting is unbalanced. The conservation identity (RM Issued + Carried In = FG + losses + balance + EGA) doesn't add up within tolerance. Adjust the totals, or request a maker-checker unbalanced-close override.",
      );
    case "no_accounting":
      return compose(
        "complete",
        "no accounting summary has been saved yet. Click Save Output / Edit Batch first so the balance check has data to work with.",
      );
    case "accounting_save_failed":
      return `Accounting summary save failed${fromBackend ? ` — ${fromBackend}` : ""}. Retry Save Output before completing.`;
    case "invalid_status":
      return compose("proceed", `job card is in status '${detail.current_status ?? detail.status ?? "?"}'.`);
    case "terminal_state":
      return `Job card is already in a terminal state ('${detail.current_status ?? "?"}'). No further changes allowed.`;
    case "locked":
      return `Job card is locked${detail.locked_reason ? ` — ${detail.locked_reason}` : ""}. Force-unlock or wait for the lock to clear.`;
    case "missing_team_leader":
      return compose("start", "assign a team leader on the Overview tab before clicking START.");
    case "missing_reason":
      return fromBackend || "A reason is required for this action.";
    case "job_card_not_found":
      return "Job card not found.";
    // ── Batches ─────────────────────────────────────────────────────
    case "batch_already_open":
      return compose(
        "open a new batch",
        `Batch ${detail.batch_number ?? ""} is already open on this job card. Close it before opening another.`,
      );
    case "batch_not_open":
      return compose(
        "save against this batch",
        `status is '${detail.status ?? "?"}', not open. Admin users can tick the override checkbox to edit a closed batch.`,
      );
    case "batch_not_found":
      return compose("save", "batch not found. The selected batch may have been removed or cancelled.");
    case "batch_jc_mismatch":
      return compose("save", "the batch belongs to a different job card.");
    case "batch_date_taken":
      return compose("open batch", "a batch already exists for that date on this JC.");
    case "batch_number_taken":
      return compose("open batch", "that batch number is already in use on this JC.");
    case "batch_has_attached_rows":
      return compose("cancel batch", "accounting rows are already attached to it. Delete those rows first.");
    case "no_open_batch":
      return compose("save output", "no batch is open. Click Open Batch first.");
    case "ambiguous_open_batch":
      return compose("save output", "multiple batches are open. Pick one in the batch selector and retry.");
    case "admin_override_forbidden":
      return "Admin override is restricted to admin-role users.";
    case "invalid_produced_qty":
      return `Invalid produced qty${fromBackend ? ` — ${fromBackend}` : "."}`;
    case "yield_unreasonable":
    case "implausible_yield":
      return `Yield looks implausible (${detail.yield_pct ?? "?"}%). Double-check the units on FG (${detail.output_qty_kg ?? "?"} kg) and RM (${detail.rm_consumed_kg ?? "?"} kg) — grams vs kg is the usual culprit.`;
    case "missing_qty":
      return compose("save", "an output qty is required (FG Actual Kg or output_qty_kg).");
    case "negative_qty":
      return compose("save", "quantities must be ≥ 0.");
    case "no_next_stage":
      return compose("dispatch", "this is the last stage in the chain; there's no next job card to push to.");
    case "chain_broken":
      return compose("dispatch", "the next job card is missing from the chain. Contact admin.");
    case "invalid_qty":
      return fromBackend || "Invalid qty.";
    case "invalid_bom_line":
      return fromBackend || "Invalid BOM line — one or more articles aren't on this job card's BOM. Refresh the page so the BOM cache rebuilds.";
    case "invalid_uom":
      return fromBackend || "Invalid UoM. Valid values: KGS / GMS / PCS / NOS / ROLL / EACH.";
    case "invalid_category":
      return fromBackend || "Invalid byproduct category. Valid: wastage / rejection / control_sample / pm_torn / pm_damaged / pm_misprint / pm_rejection / pm_wasted.";
    case "invalid_input_kind":
      return fromBackend || "Invalid input kind. Expected RM or PM.";
    case "negative_pause":
      return fromBackend || "Pause minutes must be ≥ 0.";
    case "log_not_found":
      return fromBackend || "Shift segment not found.";
    case "already_closed":
      return fromBackend || "Shift segment is already closed.";
    case "invalid_shift":
      return fromBackend || "Invalid shift code.";
    case "bad_request":
      // Middleware default code when the raised HTTPException had no error
      // field in its detail dict. Surface the rest of the response (or the
      // raw text) rather than the equally-useless "Bad request" label.
      return fromBackend || rawText || "Bad request — server didn't tell us why.";
    case "override_request_not_found":
    case "override_request_wrong_type":
    case "override_request_not_approved":
      return `Unbalanced-close override is invalid: ${code.replace(/_/g, " ")}.`;
    // ── Plans ──────────────────────────────────────────────────────
    case "not_found_or_already_cancelled":
      return "Plan not found, or it has already been cancelled.";
    case "not_found_or_invalid_status":
      return "Plan not found, or it isn't in approved status (only approved plans can be deleted).";
    case "no_lines":
      return compose("create plan", "no lines were supplied. Select at least one fulfillment card before creating the plan.");
    case "no_bom":
      return compose(
        "create plan",
        fromBackend || "one or more selected SKUs have no BOM. Set up the BOM, or remove the SKU from the selection.",
      );
    case "over_allocation":
      return compose(
        "create plan",
        fromBackend || "the requested qty exceeds the SO fulfillment's pending balance. Reduce the planned qty or pick a different fulfillment.",
      );
    case "plan_not_found":
      return "Plan not found.";
    case "no_change":
      return fromBackend || "Nothing to update — no fields changed.";
    case "job_cards_already_exist":
      return compose("approve plan", "job cards have already been generated for this plan.");
    // ── Fulfillment / SO ───────────────────────────────────────────
    case "fulfillment_not_found":
      return "Fulfillment row not found.";
    case "so_not_found":
      return "Sales order not found.";
    // ── Generic / unknown ──────────────────────────────────────────
    default:
      // Unknown code → prefer the server's own message, fall back to
      // the code itself so the operator can quote it to support.
      return fromBackend || (code ? `Server error: ${code}` : rawText || "Unknown error");
  }
}
