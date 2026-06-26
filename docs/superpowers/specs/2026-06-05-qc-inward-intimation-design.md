# Design: QC Inward Intimation (Send from Material In)

**Date:** 2026-06-05
**Status:** Approved (design) — pending spec review → implementation plan
**Repos:** `web_replica` (frontend modal + client) and `server_replica` (backend send + roles)

## Goal

From the **Material In** page, the per-PO **Send** button opens a modal to pick
articles + enter Vehicle No. and Invoice/Challan No., then sends the
`qc_inward_intimation` WhatsApp template (with a generated article-list image
header) to the QC team (`qc_member`, `qc_manager`). The article-list PNG is
generated server-side, uploaded to Meta, used as the template header image, and
the temp file is deleted after a successful send.

## Decisions (confirmed)

- **Build both** the frontend modal and a new backend send endpoint (in this
  `server_replica` checkout; the user deploys to their running backend, which
  differs from this checkout, and supplies WhatsApp credentials).
- **PNG generated on the backend** (Pillow), written to a temp file and deleted
  after the send succeeds.
- **Recipients**: add two roles `qc_member` and `qc_manager`; send to all active
  `auth_user`s assigned to those roles that have a phone number.
- **Admin**: the Admin → Users role picker is API-driven (`GET /api/v1/auth/roles`
  reads `auth_role`), so the new roles appear automatically once seeded — no
  frontend admin change required.
- Defaults: endpoint `POST /api/v1/po/{transaction_no}/intimation`; articles
  default **all-checked** in the modal; timestamp formatted `DD/MM/YYYY HH:MM`;
  permission `purchase.po` action `edit` (purchase_manager already has it).

## Template contract (`qc_inward_intimation`, English, Utility — already Active on Meta)

- **Header:** image (the generated article-list PNG).
- **Body (named params):** `po_number`, `invoice_no`, `vendor_name`,
  `vehicle_number`, `timestamp`.
- **Footer:** "QC Inward Intimation" (static, in the template).

Param sources: `po_number` ← PO header (server-derived); `invoice_no` ← modal;
`vendor_name` ← PO header (server-derived); `vehicle_number` ← modal;
`timestamp` ← server now (`DD/MM/YYYY HH:MM`).

## Frontend — `web_replica`

### Send modal (in `material-in/_MaterialInList.tsx` or a new `_SendIntimationModal.tsx`)
Opened by the existing per-row Send button (replacing the placeholder handler):
- **PO summary:** PO number + vendor (read-only).
- **Articles:** checkbox list of the PO's lines (article names), multi-select,
  **default all checked**; uses the already-fetched `getPoLines` cache (fetch if
  absent). At least one must be selected to send.
- **Vehicle No.** text input (required).
- **Invoice No. / Challan No.** text input (required).
- **Send** (disabled until valid + while sending) + **Cancel**. Inline
  success/error message. Accessible (role="dialog", Escape, labels) and
  responsive (full-width sheet on mobile).

### Client — `src/lib/po.ts`
```ts
export interface QcIntimationBody { line_numbers: number[]; vehicle_number: string; invoice_no: string; }
export interface QcIntimationResult {
  template: string;
  recipients: { role: string; phone: string; status: "sent" | "failed"; error?: string }[];
  skipped: { role: string; reason: string }[];
  errors: string[];
}
export async function sendQcIntimation(transactionNo: string, body: QcIntimationBody): Promise<QcIntimationResult>;
// POST /api/v1/po/{transaction_no}/intimation
```
Graceful errors: 404 → "QC intimation isn't available on this backend yet"; 403
→ permission message; surfaces backend `errors`/per-recipient failures.

## Backend — `server_replica`

### Endpoint: `POST /api/v1/po/{transaction_no}/intimation` (in `po_router.py`)
Body: `{ line_numbers: int[], vehicle_number: str, invoice_no: str }`.
Dependency: `require_permission("purchase", "po", action="edit")` (+ entity scope
recheck consistent with other PO endpoints). Flow:
1. Load PO header (`po_number`, `vendor_supplier_name`, `entity`) + the selected
   `po_line`s by `line_number` (404 if PO missing; 400 if no valid lines).
2. **Generate PNG** (`qc_intimation.render_article_png(article_names)`, Pillow):
   a titled list image of the selected article names → temp file (`tempfile`).
3. **Upload media** to Meta (`POST {GRAPH_BASE}/{WHATSAPP_PHONE_NUMBER_ID}/media`,
   `messaging_product=whatsapp`, `type=image/png`) → `media_id`.
4. **Resolve recipients:** `SELECT phone FROM auth_user u JOIN auth_role r ... WHERE
   r.role_name IN ('qc_member','qc_manager') AND u.is_active AND u.phone IS NOT NULL`.
   Normalize phones for WA (reuse `auth/services/phone.normalize`, strip `+`).
5. **Send** the `qc_inward_intimation` template to each recipient — components:
   header image(`media_id`) + named body params above. Collect per-recipient
   status.
6. **Delete** the temp PNG after the send loop (always, in `finally`).
7. Return `{ template, recipients[], skipped[], errors[] }`.

- **Config gate:** if `WHATSAPP_ENABLED` is false → skip steps 2–5, return a
  `"whatsapp_disabled"` result (no send) so local dev doesn't fail. Reuses
  `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_BASE`. New
  optional env `WHATSAPP_INTIMATION_TEMPLATE_NAME` (default `qc_inward_intimation`)
  and `WHATSAPP_INTIMATION_LANG` (default `en`).
- **New service:** `app/modules/purchase/services/qc_intimation.py` — `render_article_png`,
  `upload_media`, `send_template`, `send_intimation(...)` orchestrator. Keeps the
  OTP service untouched; reuses the env-based WA config.

### Roles — `app/db/auth_schema.sql` (idempotent)
Add to the role seed (`ON CONFLICT (role_name) DO NOTHING`):
```sql
('qc_member',  'QC member — receives inward intimations',  FALSE),
('qc_manager', 'QC manager — receives inward intimations', FALSE),
```
No permission grants needed (recipients, not actors). Admins assign these to
users via the existing Admin → Users UI (roles are listed dynamically).

## Error handling / edge cases
- No selected lines → 400. PO not found → 404. No QC recipients found → 200 with
  empty `recipients` + a `skipped`/`errors` note (don't hard-fail).
- Per-recipient send failures are captured individually; one bad number doesn't
  abort the batch.
- Temp PNG always deleted (`finally`), even on send failure.
- Pillow must be installed in the backend venv (verify in planning; add to
  `requirements` if missing).

## Caveats (ops / deploy — user-owned)
- The running backend differs from this checkout; the user deploys this code.
- WhatsApp creds (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`) and the
  approved template (image header + 5 named params) are the user's; code no-ops
  cleanly when `WHATSAPP_ENABLED` is false.
- "After delivered, remove the PNG" is implemented as "delete the temp file after
  a successful send" (true delivery confirmation needs webhooks — out of scope).

## Testing
- Backend (pure logic, no network): `render_article_png` produces a valid PNG;
  the template/components payload builder maps params correctly; recipient
  resolution query shape; `WHATSAPP_ENABLED=false` short-circuit; temp-file
  cleanup in `finally`.
- Frontend: `tsc --noEmit` + lint + `next build`; manual smoke — modal opens,
  defaults all articles checked, validates Vehicle/Invoice, posts; graceful
  error when the endpoint is absent on the live backend.
- Admin: confirm `qc_member`/`qc_manager` appear in the role picker after seeding
  (and that the picker applies no hidden role filter).

## Decomposition (for the plan)
- **Phase A (backend):** roles seed; `qc_intimation.py` (PNG + media + send);
  the `/intimation` endpoint; config/env additions.
- **Phase B (frontend):** `lib/po.ts` `sendQcIntimation`; the Send modal; wire the
  Material In Send button; verify build.
- **Phase C (admin verify):** confirm role picker lists the new roles (likely no
  code change).
