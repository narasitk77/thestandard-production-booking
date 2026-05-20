# Operations Log — Production Booking

A running journal of infrastructure events, fixes, and operator actions on
the self-hosted Portainer deployment at `probook.xtec9.xyz`. Newest first.

---

## 2026-05-20 · Docker host DNS — `ghcr.io` unresolvable

**Symptom (Portainer notification):**
```
Failed to pull images of the stack: compose pull operation failed:
Error response from daemon:
Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io on 192.168.21.221:53:
no such host
```

Plus the recurring warning from the same incident:
```
Failed to fetch latest commit id of the stack 125: failed to list
repository refs: Get ".../info/refs?service=git-upload-pack":
dial tcp: lookup github.com on 127.0.0.11:53: server misbehaving
```

**Impact**

- `sha-b597c3c` (latest committed: Episode-Type unification + แขก/Subject
  rename + Shoot Type cleanup) **cannot be pulled** — the Docker daemon
  itself can't resolve external hostnames.
- Live deploy stays on `sha-bf9c7b9` (last successful pull). All previous
  features remain available; only the changes in `b597c3c` are absent.
- The Apps Script Web App is unaffected (Google-hosted).

**Diagnosis**

Two distinct DNS failures on the same host:

1. **Docker daemon → `192.168.21.221:53` → `ghcr.io`: no such host.**
   The host's resolv.conf (or Docker daemon DNS) is pointing at the local
   DNS box `192.168.21.221`, which either doesn't have an upstream
   forwarder configured or its forwarder is dead — public hostnames fail.

2. **Portainer container → `127.0.0.11:53` → `github.com`: server
   misbehaving.** `127.0.0.11` is the Docker embedded resolver inside the
   container; it forwards to the daemon's DNS, which is again
   `192.168.21.221`. Same underlying issue.

Both point to one root cause: the LAN DNS server at `192.168.21.221`
is not resolving external names. Docker won't get healthy DNS until
either that box is fixed OR Docker is configured to bypass it.

**Recommended fix (host-level, no app changes)**

Patch `/etc/docker/daemon.json` on the host (192.168.21.220) to use
public resolvers directly, bypassing the broken LAN DNS:

```json
{
  "dns": ["1.1.1.1", "8.8.8.8"]
}
```

Then `sudo systemctl restart docker`. This restarts every container
(~1 min downtime) but unblocks every GHCR/Docker Hub pull from that
host. Idempotent — safe to re-apply.

**Workaround until fixed**

- Stack stays on `sha-bf9c7b9` (already cached on the host — Update
  the stack without re-pull works fine on that tag).
- Don't bump `IMAGE_TAG` until DNS is healthy, or Portainer will fail
  to pull and the stack may be left in a half-restarted state.

**Status: open** — waiting on SSH access to the host to apply the
`daemon.json` change.

---

## 2026-05-20 · Pilot Dashboard sheet — `Anyone with link can edit` is too open

The pilot copy `1rMLmQIS237UDKLtTjTP0IC9pZ_4eWn4FxiTG0XflARw` was shared
with public-write (`{type:anyone, role:writer}`). This works for the
booking app's service account (it's covered by "anyone"), but means
anyone who learns the sheet ID can rewrite the booking data.

**Recommended:** open the sheet → Share → switch "General access" from
"Anyone with the link" to "Restricted" → add the service account email
(`GOOGLE_SERVICE_ACCOUNT_EMAIL` from Portainer stack env) as Editor.

**Status: open** — flagged to the operator, not yet fixed.

---

## 2026-05-20 · Apps Script Web App — propagation + curl redirect quirk

When first deployed to the pilot copy, `curl -L -X POST` against the
Web App URL returned the Drive "ไม่พบเพจ" 404 page even with `Anyone`
access. Switching the client to Node `fetch` (what the booking app uses
in production) returned the expected JSON immediately — root cause was
the curl redirect chain on Apps Script POSTs (curl mishandles the
follow-up to `script.googleusercontent.com`), not anything about the
deployment.

**Resolved.** All three smoke tests (wrong secret / bad type /
bad projectId) returned the expected `{ok:false, error:...}` JSON.

---
