# Runbook — swap Producer Dashboard sheet (sandbox ↔ production)

> ⚠️ **Updated v1.148.3 — the model is now the other way around.**
> The **production** Producer Dashboard sheet (`10TnR0…pSzL4`, the one the
> team actually uses and the PMDC Airtable sync reads daily) is the
> **built-in default** — no env override needed to run production. This
> replaces the old, incorrect assumption that the hardcoded id was a
> "sandbox" you had to override away from (that mislabel made
> `/api/health` always show `SANDBOX` and made the backfill guard 409
> every real `apply`). Today there is **no separate sandbox sheet**.
> Set `PRODUCER_DASHBOARD_SHEET_ID` **only** if you deliberately want to
> point the app at a *different* throwaway/test sheet — that (and only
> that) turns `isSandbox` on and re-arms the backfill guard. The steps
> below are the generic "point at some other sheet" procedure.

## TL;DR

1. Find the new sheet's **spreadsheet id** (the long random string in the
   Google Sheets URL after `/d/` and before `/edit`).
2. Share the new sheet with **both**:
   - `production-booking@production-booking-494605.iam.gserviceaccount.com`
     (the service account — needs **Editor** access so the app can write
     the Bookings tab back to it).
   - The DWD impersonate user (`narasit.k@thestandard.co`) with
     **Editor** access if you want to bypass the service account path.
3. Verify the new sheet has the required tabs:
   `All Projects` · `_Users` · `_EPs` · (`Bookings` is created on first
   write, no need to pre-make it)
4. In Portainer → `production-booking` stack → **Environment variables**:
   - Edit `PRODUCER_DASHBOARD_SHEET_ID` → paste the new id.
   - Click **Save settings**.
   - Click **Pull and redeploy** (no need to toggle "Re-pull image"
     unless you also want a fresh image build).
5. After deploy, open `/admin/health` and confirm:
   - `Producer Dashboard sheet` section → `Source: env`, and the
     masked id matches the sheet you pasted.
   - `Mode: ⚠ SANDBOX` — **this is the expected state** (v1.148.3
     semantics: any env override away from the production sheet shows
     the amber warning and re-arms the backfill guard). If you see
     `✓ Production` instead, either the env var didn't take (stale
     container) or you pasted the production id.
   - `Live checks → Producer Dashboard sheet` → green check, returns
     the sheet's title.
6. Create one test booking with outlet **Content Agency (AGN)** to
   exercise the new sheet end-to-end. Confirm a row appears in the
   `Bookings` tab of the new sheet.
7. Approve + assign crew → calendar event should still fire (DWD path
   is independent of the Producer Dashboard sheet).

## Why this is risky if done wrong

- **Service account loses access** → app silently fails to read Project
  IDs / Episodes / Users for Content Agency bookings. Wizard step 4
  shows "No projects loaded (sheet unreachable)".
- **Wrong sheet id pasted** → reads work but against the wrong data.
  CA bookings get written into someone else's sheet — and CA users see
  ghost projects from someone else's pipeline.
- **Forgetting to redeploy** → env var saved in Portainer UI but stale
  container keeps the old value.

## What's centralized vs. what isn't

As of **v1.30** all sheet-id reads go through
`src/lib/google-config.ts` → `getProducerDashboardSheetId()`. There is
no longer a hardcoded sheet id duplicated across `google-sheets.ts`,
`projects.ts`, `people.ts`, `dashboard-episodes.ts`. The only hardcoded
value is the **production default** in `google-config.ts`
(`PRODUCTION_PRODUCER_DASHBOARD_SHEET_ID`), used when the env var is
unset — and `/admin/health` flags `⚠ SANDBOX` only when the env var
overrides it to a *different* sheet.

## Verification checklist (copy this into a Slack/Notion message after a swap)

```
Swap done at: <timestamp>
Old sheet id (masked): <from /admin/health before swap>
New sheet id (masked): <from /admin/health after swap>

/admin/health checks:
  [ ] Database round-trip green
  [ ] Google Calendar green
  [ ] Producer Dashboard sheet green — title: <expected title>
  [ ] "Mode: ⚠ SANDBOX" (expected — the env override ≠ production
      sheet; "✓ Production" here means the swap did NOT take effect)

Smoke booking:
  [ ] Created test CA booking with outlet AGN
  [ ] Project list loaded from NEW sheet (no "no projects" warning)
  [ ] Producer/Director dropdowns loaded from NEW sheet
  [ ] After approve+assign, calendar event created with assigned crew
  [ ] Row appears in NEW sheet "Bookings" tab

Rollback plan (if anything broke):
  - In Portainer stack env, restore PRODUCER_DASHBOARD_SHEET_ID to its
    previous value — to return to production, remove the override
    entirely (the production sheet is the built-in default)
  - Save settings + Pull and redeploy
  - Cancel + restore the test booking via /admin/[id] (calendar event
    will be re-deleted)
```

## Notes

- The app caches sheet reads for ~5 min (`CACHE_TTL_MS` in
  `projects.ts` / `people.ts`). If you don't see the new sheet's data
  immediately after a swap, give it 5 min or restart the container.
- The "Bookings" tab name can be overridden via `BOOKINGS_TAB` env if
  the new sheet uses a different tab name.
- `GOOGLE_SHEETS_ID` env var (separate from `PRODUCER_DASHBOARD_SHEET_ID`)
  exists in the Portainer stack env but is **not currently consumed by
  any app code** (verified 2026-05-24). Safe to leave or remove.
