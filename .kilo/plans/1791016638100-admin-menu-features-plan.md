# Plan: Add competitor admin menu features (Affiliates deferred)

## Objective
Add the missing admin-panel features from the competitor screenshot onto the existing
Jay Rajput Media Power codebase (Affiliates OUT OF SCOPE). Plan handoff only — no implementation.

## Current state (verified)
- Stack: Node 20 / Express / PostgreSQL (Neon) / pg / Cloudinary / bcrypt / JWT / Cashfree.
- Admin tabs (`switchAdminTab`, `public/admin.html`): **Services, Orders, Providers, Uploads**.
- API routes (`server.js`): auth register/login/google; `/api/services`; orders create/my-orders;
  wallet via Cashfree `/api/cashfree/*` + `/api/wallet/payments` + admin-only `/api/wallet/add-funds`;
  `/api/support/tickets` (user create/list); admin providers/services/orders/images/dedup/sync/preview/import.
- DB tables: `users, services, orders, tickets, transactions, payment_orders, upstream_providers,
  provider_services, api_keys`. Live `services` has `image, provider_id, cost_per_1000` beyond the
  stale inline DDL → use idempotent migrations, not the inline `CREATE TABLE`.
- Order statuses: default `Pending`; admin `allowedStatuses = [Pending, In Progress, Completed,
  Canceled, Refunded]`; provider map: pending/in progress/completed/partial/canceled.

## Decided design choices (recommendations, reversible)
- Scope: all new features ADMIN-panel pages, except Tickets (user create + admin handle) and
  Appearance (GLOBAL theme set by admin → applies to all users).
- **Special pricing** → per-user, per-service override table `user_service_prices(user_id, service_id,
  custom_rate_per_1000)`; used in `placeOrder()` in place of `service.rate_per_1000` when a row exists.
- **Services "create category"** → lightweight `categories` table + picker (controlled list beats free text).
- **Order statuses** → adopt `Awaiting, Pending, Processing, In Progress, Completed, Cancelled, Failed`;
  keep TEXT column; back-fill old rows via a one-time UPDATE mapping (Canceled→Cancelled) — inclusive set.
- **Payments** → its own admin tab (Payments ledger); separate from Orders tab.
- **Appearance** → preset theme palettes stored in `site_themes` + active flag; served via public
  `GET /api/settings`; applied as CSS variables by client on load. Preset themes: Default, Diwali, Holi,
  Eid, Christmas (+ user can add more via admin).

## Feature breakdown

### 1. Dashboard (admin) — MISSING
- Tab `Dashboard`; KPI widgets.
- `GET /api/admin/dashboard` → { users, active_services, orders_today, orders_total, revenue_today,
  revenue_total, pending_orders }. No schema change.

### 2. Users (admin) — MISSING
Spec: list/search/add; per-user: edit / set password / sign-in history / suspend / special pricing.
- Endpoints: `GET /api/admin/users?q=&page=`, `POST /api/admin/users`, `PUT /users/:id`,
  `PUT /users/:id/password`, `POST /users/:id/impersonate` (admin-only; returns user JWT; audit-log it),
  `GET /users/:id/logins`.
- Schema (idempotent): `users.status TEXT DEFAULT 'active'` (suspend), `user_logins(...)`,
  `user_service_prices(...)`.
- UI: user table + per-row action dropdown + sign-in-history modal.

### 3. Services (admin) — add Duplicate + Categories
Spec: add/edit/description/activate/deactivate/delete/import exist; gaps = duplicate + create category.
- `POST /api/admin/services/:id/duplicate` (clone w/ "(copy)"); add "Duplicate" row button.
- `categories` table + `GET/POST /api/admin/categories`; category picker on service form.
- Custom price = Users #2 (per-user override). (Service-level `custom_rate_per_1000` deferred — per-user covers it.)
- Import service: EXISTS — skip.

### 4. Orders (admin) — extend statuses + search + Payments ledger
- Extend `allowedStatuses` + provider status map to the Decided set (see above). Add `GET /api/admin/orders`
  with q (order id / service name / user email) + status filter + pagination.
- Payments ledger: `GET /api/admin/payments?q=&status=` joining `payment_orders`+`transactions`+`users`
  (search order_id, user name/email, amount, status, date).
- UI: Orders tab (search + status filter + status select); Payments tab (ledger + search).

### 5. Tickets (admin) — add handler
- Existing: user `POST/GET /api/support/tickets`.
- Schema: `ticket_replies(id, ticket_id, sender_user_id, message, is_admin, created_at)`;
  extend `tickets.status` → `Open, In Progress, Resolved, Closed`.
- Endpoints: `GET /api/admin/tickets`, `GET /api/admin/tickets/:id` (thread), `POST /tickets/:id/reply`,
  `PUT /tickets/:id/status`.
- UI: Tickets tab (list + filter + thread modal + reply).

### 6. Appearance (admin) — GLOBAL themes
- Schema: `site_settings(key PK, value)` + `site_themes(id, name, palette_json, banner_url, is_active)`.
- Endpoints: `GET /api/settings` (public, returns active theme → CSS vars); admin
  `GET/PUT /api/admin/settings/appearance`, `GET/POST /api/admin/settings/themes`.
- Client: `index.html` + `admin.html` fetch `/api/settings` on load and apply CSS vars (global theme);
  Appearance tab lists swatches (hover preview) + Activate.

## Implementation order (dependencies)
1. Migrations (idempotent): `users.status`, `user_logins`, `user_service_prices`, `ticket_replies`,
   `site_settings`, `site_themes`, `categories`. ← required by #2,#3,#5,#6
2. Backend routes (admin + public `/api/settings`): Dashboard (#1), Users (#2), Orders+Payments (#4),
   Tickets (#5), Appearance (#6); extend order `allowedStatuses` + provider map (#4).
   Note: `placeOrder()` reads `user_service_prices` (custom pricing) — add during Users work.
3. Admin nav: add tabs Dashboard, Users, Payments, Tickets, Appearance (keep Services/Orders/Providers/Uploads).
4. Tab UIs (#1–#6) in `admin.html`.
5. Client theme bootstrap on `index.html` + `admin.html` (#6).
6. Smoke test (see Validation).

## Data safety / back-compat
- Never alter existing Services/Orders/Providers/Uploads/import-sync behavior (live, deployed).
- Cashfree webhook/verify flow untouched.
- Order status: keep accepted set INCLUSIVE (old statuses still valid) during transition.
- Impersonation: admin-only, never expose another user's password; log admin id + target user id.
- New admin endpoints gated by `requireAdmin`; existing public endpoints unchanged.

## Validation
- `node -c server.js` after edits.
- Migrations idempotent (re-runnable, no data loss).
- New admin routes 403 for non-admin; public `/api/settings` works unauthenticated.
- New tabs render (data or empty state); Dashboard numbers match DB counts; order status set saved/returned;
  Payments ledger searchable; theme switch reflects on the public site after refresh.

## Out of scope
- Referrals/Affiliates.
- Changing existing live flows (Services/Orders/Providers/Uploads/imports).
- Scratch files (already removed).
