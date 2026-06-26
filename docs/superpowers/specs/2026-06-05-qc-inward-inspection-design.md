# Design: QC module · Inward Inspection (full stack)

**Date:** 2026-06-05
**Status:** Approved (design) — pending spec review → implementation plan
**Repos:** `server_replica` (new `/api/v1/qc` backend) and `web_replica` (new QC module frontend)
**Source of truth for fine detail:** `frontend_replica/src/modules/quality-control/inward-check/inward-check.js` (~1690 lines), `inward-check/index.html`, `quality-control.js`.

## Goal

Replicate the Electron "Inward Check" feature as a new **QC** module whose first
sub-module is **Inward Inspection**: a status-filtered list of QC inspections and
a detail view to start an inspection from a pending dock-arrival intimation,
capture readings, attach/replace/request a vendor COA, set/override a verdict,
and cancel/reopen — with an audit timeline. Built **full stack now**; some pieces
are functional stubs until upstream data exists (see Deferrals).

## Decisions (confirmed)

- Build the **full stack** (backend `/api/v1/qc` + frontend) in one effort,
  accepting it is scaffolding until `qc_intimation` rows + spec master are
  populated.
- **Intimation source is deferred** — build the `qc_intimation` table + the
  `GET /api/v1/qc/intimations` list endpoint and **seed a few rows**; the user
  will specify how rows are created (e.g. from Material In Send) later.
- **Role matrix:** inspect actions (start / readings / verdict / cancel / reopen /
  update header) → `qc_inspector`, `qc_manager`, `admin`. **Verdict override** →
  `qc_manager`, `admin` only. Read/list → those plus `viewer`.
- Reuse the **existing** receipt COA endpoints (`/api/v1/receipt/coa*`,
  `coa-upload`, `coa-vendor-request`, `files/{token}`) — no backend change there.
- Reuse the **existing** NCR raise endpoint (`POST /api/v1/ncr/raise`) when a
  verdict is `failed`.

## Backend — new `server_replica/app/modules/qc/`

### DB migration `app/db/0NN_qc_inspection.sql` (idempotent; reconcile with the partial sketch in `ims_new_schema.sql`)
- `qc_intimation` — `qc_intimation_id PK`, `po_number`, `transaction_no`, `sku_id`,
  `sku_name`, `sku_name_raw`, `supplier_id`, `supplier_name`, `lot_number`,
  `vehicle_no`, `warehouse`, `entity`, `status` (`pending`|`locked`|`consumed`),
  `coa_received bool`, timestamps. (Population deferred; seed a couple rows.)
- `qc_parameter` — `parameter_id PK`, `name`, `unit`. `qc_sku_spec` —
  `(sku_id, parameter_id)` → `spec_min`, `spec_max`, `spec_target`. Minimal spec
  master; seeded with a few examples.
- `qc_inspection` — `inspection_id PK`, `qc_intimation_id FK`, `status`
  (`in_progress`|`readings_submitted`|`verdict_passed`|`verdict_failed`|`cancelled`),
  `verdict` (`passed`|`failed`|null), `sample_size`, `inspection_method`
  (`visual`|`lab_test`|`combined`), `inspector_user_id`, `started_at`,
  `started_by`(+name), `verdict_at`, `accepted_qty`, `rejected_qty`, `ncr_no`,
  `cancelled_at`/`cancelled_by`/`cancel_reason`, `reopened_at`/`reopen_reason`,
  `verdict_overridden_by`/`override_reason`, `remarks`, plus denormalized
  display fields (`po_number`, `transaction_no`, `sku_id/name/raw`,
  `supplier_id/name`, `lot_number`, `vehicle_no`, `warehouse`).
- `qc_reading` — `reading_id PK`, `inspection_id FK`, `parameter_id`,
  `observed_value_num`, `observed_value_text`, snapshot `spec_min/max/target`,
  `is_within_spec`, `severity` (`minor`|`major`|`critical`), `deviation_pct`,
  `method`, `instrument`, `notes`, `recorded_at`.
- `qc_inspection_audit` — `event_type`, `from_state`, `to_state`, `occurred_at`,
  `actor_user_id`, `payload_diff jsonb`.

### Endpoints (`router.py`, `prefix=/api/v1/qc`; mount in `app/main.py`)
All gated by `require_permission("qc","inspection", action=…)` per the role matrix.

| Method | Path | Action perm | Purpose |
|--------|------|------------|---------|
| GET | `/inspection` | read | list+filter (page,page_size,status,transaction_no,supplier_id,sku_id,verdict,from_date,to_date) → `{items,total,total_pages}` |
| GET | `/inspection/{id}` | read | full detail incl. nested `readings[]` |
| GET | `/inspection/{id}/audit` | read | audit event list |
| POST | `/inspection/start` | create | `{qc_intimation_id,sample_size,inspection_method,remarks?}` → `{inspection_id}`; locks intimation |
| GET | `/intimations` | read | pending intimations picker (status=pending,limit,q?) |
| POST | `/inspection/{id}/readings` | edit | `{readings:[{parameter_id,observed_value_num?,observed_value_text?,method?,instrument?,notes?}]}` → `{inserted_count,out_of_spec_count}`; server hydrates spec + compliance; status→readings_submitted |
| PUT | `/inspection/{id}/readings/{rid}` | edit | edit one reading; re-derive compliance |
| DELETE | `/inspection/{id}/readings/{rid}` | edit | delete reading (audit reason) |
| POST | `/inspection/{id}/verdict` | edit | `{verdict,accepted_qty?,rejected_qty?,summary_remarks?}`; pass requires zero OOS (else `out_of_spec_readings_present`); fail → auto NCR via `/api/v1/ncr/raise` |
| POST | `/inspection/{id}/verdict/override` | (override: qc_manager/admin) | `{new_verdict,reason(min10)}` |
| POST | `/inspection/{id}/cancel` | edit | `{reason(min3)}`; →cancelled; re-queue intimation |
| POST | `/inspection/{id}/reopen` | edit | `{reason(min3)}`; →in_progress; re-bind intimation |
| PUT | `/inspection/{id}` | edit | partial header update (`sample_size?,inspection_method?,inspector_user_id?,remarks?`) |
| POST | `/inspection/{id}/rm-report` | edit | **stub**: generate RM report (pass only) → `{report_id,download_url?}` |
| POST | `/inspection/{id}/ncr-report` | edit | **stub**: generate NCR report (fail only) |

### Services
`inspection_service` (status machine, start/cancel/reopen/update + audit),
`readings_service` (CRUD + spec hydrate/compliance compute), `verdict_service`
(verdict, override gate, NCR integration), `reports_service` (RM/NCR stub —
simple PDF via the installed pdf lib or a placeholder URL; no S3). Every state
transition writes a `qc_inspection_audit` row.

### Permissions — `app/db/auth_schema.sql` (idempotent)
Add `('qc','inspection',NULL,'read'|'create'|'edit'|'delete', …)`. Grant
read+create+edit to `qc_inspector`, `qc_manager`; full to `admin` (admin bypasses
anyway). Override is enforced in code (role ∈ {qc_manager, admin}). `viewer` →
read. Entity scope: NULL (all) for now.

## Frontend — new `web_replica/src/app/modules/qc/`
- `page.tsx` — QC landing (submodule grid; only **Inward Inspection** live) +
  `_chrome.tsx` (`QcChrome`, mirrors `PurchaseChrome`).
- `inward-inspection/page.tsx` — owns list/detail view switching + shared state.
- `inward-inspection/_list.tsx` — status pills (All/In Progress/Readings
  Submitted/Passed/Failed/Cancelled), filters (search txn, supplier_id, sku_id,
  verdict, date range, apply/clear/refresh), table (Transaction No, Article,
  Vehicle, Warehouse, Status badge, Actions: RM/NCR/Edit/View), 20/page pagination.
- `inward-inspection/_detail.tsx` — header (id, status+verdict badges, meta) +
  cards: **Inspection details**, **Readings** (table + add/edit/delete during
  in_progress), **Vendor COA** (list + upload/replace/delete/request via receipt
  endpoints), **Audit timeline**; status-driven action bar (Update header /
  Cancel / Submit readings / Set verdict / Override / Reopen / Reload).
- `inward-inspection/_modals/` — Start, AddReadings, EditReading, DeleteReading,
  SetVerdict, OverrideVerdict, Cancel, Reopen, UpdateHeader, UploadCoa,
  ReplaceCoa, DeleteCoa, RequestCoa (13).
- `src/lib/qc.ts` — typed client for all `/api/v1/qc/*` + the reused
  `/api/v1/receipt/coa*` calls; consistent `readError`/`apiFetch` pattern.
- Register **QC** in `src/lib/modules.tsx` (`route: "qc"`, `implemented: true`).

## Error handling
Map the documented error codes to messages (e.g. `out_of_spec_readings_present`,
`permission_denied`, `file_too_large`, `coa_not_active`, `not_approved`,
`not_rejected`, `ncr_not_assigned`). Modals stay open on error and re-enable.
Frontend client special-cases 404 → "QC backend not available on this server yet".

## Deferrals / functional stubs (explicit)
- `qc_intimation` **population** — table + list + seed only; real source TBD by user.
- **RM/NCR reports** — functional stub (local PDF or placeholder URL; no S3).
- **Spec master** — minimal seed; compliance computed only where a spec row exists
  (else `is_within_spec=null`).
- COA — reuses existing receipt endpoints unchanged.

## Decomposition (phases for the plan)
1. Backend DB migration + permissions seed.
2. Backend schemas.
3. Backend services (inspection/readings/verdict/reports + audit).
4. Backend router + mount + verify import.
5. `lib/qc.ts`.
6. QC landing + `QcChrome` + module registration.
7. Inward Inspection **list**.
8. Inward Inspection **detail** (cards + action bar).
9. The **13 modals**.
10. Verify both repos (pytest-free backend import + tsc/lint/build).

## Verification
Backend: `python -c "import app.main"` clean; targeted unit checks for the status
machine, readings spec compute, verdict OOS guard, and the reports stub. Frontend:
`tsc --noEmit` + lint + `next build`; manual smoke against the seeded intimations.
No repo test harness on the frontend (per prior specs) — gate on build + manual.
