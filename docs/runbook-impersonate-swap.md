# Runbook — swap the DWD impersonate subject

## When you need this

The Google Calendar integration in this app uses **Domain-Wide
Delegation (DWD)** to impersonate a Workspace user when creating events.
A bare service account cannot invite attendees; impersonating a user
gives it that ability. Today the impersonate subject is
`narasit.k@thestandard.co` — set via:

1. `GOOGLE_IMPERSONATE_SUBJECT` env var in the Portainer stack (preferred), or
2. The hardcoded fallback in `src/lib/google-calendar.ts` (v1.29.4)
   if the env var is unset/empty.

You need to swap when:

- The current impersonate user **leaves the company** or rotates roles.
- The user **loses Editor access** to the shared calendar
  (`THE STANDARD Production Bookings`).
- Workspace admin **revokes DWD** for the service account and you need
  to re-grant it under a different user.
- You're spinning up a **second environment** (staging) that should use
  a different user.

## How to swap (5 minutes)

1. **Pick the new impersonate user.** Must be a `@thestandard.co`
   account with:
   - Editor access on the shared calendar
     `72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com`
     (share via Google Calendar UI → Settings & sharing → Add people).
   - DWD grant in Workspace admin for the service account's client ID
     (`106117530552798836735`) with scope
     `https://www.googleapis.com/auth/calendar`. This grant covers ALL
     `@thestandard.co` users by default, so a fresh user inherits it
     without re-granting.

2. **Update the Portainer stack env:**
   - Open the production-booking stack → Environment variables →
     Advanced mode.
   - Add or update:
     ```
     GOOGLE_IMPERSONATE_SUBJECT=new-user@thestandard.co
     ```
   - **Save settings**, then **Pull and redeploy** (toggle "Re-pull
     image" if you also want a fresh image — not required for an env
     change).

3. **Verify on `/admin/health`:**
   - The "Source" badge under "Google Calendar" should change from
     amber `hardcoded fallback` to green `env`.
   - The amber warning banner should disappear.
   - The "Google Calendar — full scope · DWD impersonate" live check
     should be green.

4. **Smoke-test:** approve any booking with assigned crew, then check
   the Google Calendar event to confirm the new user is the organizer
   and guests received invites.

## What survives the swap

- **Existing calendar events stay valid.** Past events remain on the
  shared calendar with whoever was organizer at the time. They keep
  receiving RSVPs and reminders.
- **Past calendar invites stay valid.** Attendees on past events can
  still RSVP.
- **Only NEW event creates / attendee patches use the new impersonate
  subject.** The reconciler worker on its next 10-min tick will start
  using it for any sync work needed.

## What does NOT survive

- **The previous user is no longer the "creator" of new events** — the
  new user becomes the organizer for everything created after the swap.
- **If the previous user is fully off-boarded** (Workspace account
  suspended/deleted) and they still own past events, those events may
  be orphaned. Transfer ownership ahead of off-boarding via Google
  Calendar UI.

## If the new user doesn't have calendar access

You'll see this on `/admin/health`:

```
✗ Google Calendar — full scope · DWD impersonate
  Error: Insufficient Permission / Calendar access denied / 403
```

Fix:

1. Share the production calendar with the new user (Google Calendar UI
   → Settings → THE STANDARD Production Bookings → Share with specific
   people → Add → "Make changes to events" or higher).
2. Wait 5 minutes for Google to propagate the access change.
3. Hit `/admin/health` Re-check → should turn green.

If still red after step 3, the DWD grant likely doesn't include this
user. Check Google Admin → Security → API controls → Domain-wide
delegation → service account client ID `106117530552798836735` → scope
list. Should include `https://www.googleapis.com/auth/calendar`. If
that scope is missing, add it.

## Rolling back

Revert the env var in Portainer:
- Either delete `GOOGLE_IMPERSONATE_SUBJECT` (the code falls back to
  the hardcoded `narasit.k@thestandard.co`), or
- Set it back to the previous user's email.

Save + Pull and redeploy. The "Source" badge on `/admin/health` will
flip back to `hardcoded fallback` (amber) or `env` (green) accordingly.

## Long-term: multi-fallback list (not yet implemented)

If single-person dependency keeps being a risk (frequent rotations,
multiple Workspace tenants, etc.), v1.32.0+ could be extended to
support a comma-separated list:

```
GOOGLE_IMPERSONATE_SUBJECTS=alice@thestandard.co,bob@thestandard.co
```

The code would try each in order until calendar API succeeds. Not yet
shipped because the current single-user setup has been stable since
v1.29.4. Track via Phase B follow-up in `docs/architecture.md`.
