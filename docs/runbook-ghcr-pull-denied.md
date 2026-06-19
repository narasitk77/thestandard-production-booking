# Runbook — Portainer "denied: denied" when pulling the GHCR image

## ✅ ACTUAL ROOT CAUSE & FIX (resolved 2026-06-17)

The real cause was **a second authenticated `ghcr.io` registry in Portainer**
("tsd-proof", URL `ghcr.io`, authenticated as GitHub user **earthnpp**). Portainer
applied earthnpp's token to **every** `ghcr.io` pull — including
`ghcr.io/narasitk77/thestandard-production-booking` (public). earthnpp's token has
no access to narasitk77's package, and **presenting an unauthorized token disables
the anonymous fallback**, so GHCR returns `denied` even though the image is public.

**Why the "obvious" fixes didn't work:**
- An **anonymous** registry scoped to `ghcr.io/narasitk77` does NOT override the
  broad authed `ghcr.io` entry (anonymous = no auth written → daemon falls back to
  earthnpp's token). Verified: still `denied`.
- Adding a **new authenticated** registry is **paywalled in Portainer CE** (the
  Authentication toggle pops "Upgrade Portainer").

**The fix that worked (no credential entry, keeps earthnpp working):**
1. Portainer → Registries → **tsd-proof** → change Registry URL from `ghcr.io`
   to **`ghcr.io/earthnpp`** → Update registry. Now it only matches earthnpp's own
   images; it stops hijacking narasitk77's pulls. (earthnpp's images still pull fine.)
2. Added an anonymous registry **`GHCR-narasitk77`** = `ghcr.io/narasitk77` so
   narasitk77's public images resolve to an anonymous (no-token) pull.
3. Stack `production-booking` → Pull and redeploy → **Update** → pull succeeds.

**Prevention:** never give a `ghcr.io` registry in Portainer a host-wide URL when
the token only covers one account's packages — scope it to `ghcr.io/<that-account>`.
Public images need no registry entry at all (or an anonymous, account-scoped one).

---

## (Original investigation notes below — superseded by the section above)

## Symptom
Portainer "Pull and redeploy" fails:
```
Failed to pull images of the stack: compose pull operation failed:
Error response from daemon: Head "https://ghcr.io/v2/narasitk77/thestandard-production-booking/manifests/<tag>": denied: denied
```

## Root cause (verified 2026-06-17)
The image is **public** and pullable by anyone — proven with an anonymous pull:
```
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:narasitk77/thestandard-production-booking:pull" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/narasitk77/thestandard-production-booking/manifests/sha-b68edc6
# => 200  (latest and every sha tag also return 200)
```
So `denied` is **not** about the image. It means a **stale / expired `ghcr.io`
credential** is being sent on the pull. A broken credential is worse than no
credential: the daemon authenticates and fails instead of falling back to the
anonymous pull that a public image allows. (This is why it "worked before" — the
PAT was valid then; GitHub classic PATs expire.)

## The credential can live in two places
1. **Portainer → Registries** — a GitHub/ghcr.io registry entry with an expired PAT.
2. **The Docker host's `config.json`** — from a past `docker login ghcr.io`
   (usually `/root/.docker/config.json` for the user the daemon runs as).

## Permanent fix (so it does not happen again)
Because the image is public, **no credential is needed at all** — remove it.

1. **Portainer:** Registries → delete any `ghcr.io` / GitHub entry (or, if you want
   to keep it, edit it with a fresh PAT that has `read:packages`). Also check the
   stack's pull settings don't reference a stale registry.
2. **Host (the catch-all — do this if step 1 doesn't clear it):** SSH to the
   Docker host and run:
   ```
   docker logout ghcr.io
   docker pull ghcr.io/narasitk77/thestandard-production-booking:sha-b68edc6   # should succeed now
   ```
3. Back in Portainer: set the stack's `IMAGE_TAG` and **Pull and redeploy**.

**Recurrence prevention:** keep the package **public** and keep **no GHCR PAT** in
Portainer/host for this registry. With no credential to expire, anonymous pulls of
the public image never break. (Only re-add a PAT if you make the package private.)

## Verify the fix
- Host: `docker pull ghcr.io/narasitk77/thestandard-production-booking:sha-b68edc6` → success.
- Portainer: stack redeploys; container logs show `start.sh` running `prisma db push`.
- App: `/api/health` green.
