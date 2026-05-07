# Portainer Deployment

Step-by-step guide for deploying THE STANDARD Production Booking on a self-hosted Portainer instance (e.g. `thestandard.fortiddns.com:9000`).

This is an alternative to the Render deployment. It uses the same codebase but runs the database and app on your own Docker host.

---

## 1. Pre-flight checklist

Before you start, gather these:

| What | Where to get it |
|------|-----------------|
| **Public URL** the app will live at | Decide a port on your Portainer host (e.g. `:3001`) and the FQDN, e.g. `http://thestandard.fortiddns.com:3001` |
| **Google OAuth Client ID + Secret** | Reuse the existing one from Render env vars, or create a new client at [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) |
| **Google Service Account** (for Sheets/Calendar) | Reuse the existing one from Render |
| **Strong PostgreSQL password** | `openssl rand -base64 24` |
| **NextAuth secret** | `openssl rand -base64 32` |

### Add the new redirect URI to Google OAuth

In the Google OAuth client → **Authorized redirect URIs**, add:

```
http://thestandard.fortiddns.com:3001/api/auth/callback/google
```

(Adjust the host/port to whatever you chose.) Without this, sign-in will fail with `redirect_uri_mismatch`.

---

## 2. Add the stack in Portainer

1. Go to **Stacks → Add stack**
2. **Name:** `production-booking`
3. **Build method:** select **Repository**
4. Fill in:
   - **Repository URL:** `https://github.com/narasitk77/thestandard-production-booking`
   - **Repository reference:** `refs/heads/main`
   - **Compose path:** `docker-compose.portainer.yml`
   - **Authentication:** ON — paste a GitHub Personal Access Token with `repo` scope
     (the repo is private)
5. **Environment variables:** paste the contents of `.env.portainer.example` and fill every `<...>` placeholder. The compose file enforces required vars (`POSTGRES_PASSWORD`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) — the stack will fail to start if any are missing.
6. **Deploy the stack.**

First deploy takes 3–5 min (npm install + Next.js build). Watch logs in Portainer → Stacks → `production-booking` → `app` container.

---

## 3. Verify

| Check | How |
|-------|-----|
| App container is healthy | Portainer → Containers → `production-booking-app` should show `running` |
| DB migration ran | Logs of `production-booking-app` should show `Prisma: pushing schema...` then `> Ready in ...` |
| Sign-in works | Browse to your public URL → click sign in → consent screen shows `gmail.send` permission → land on dashboard |
| Email send works | Admin → any booking → Test Email button (or assign someone) → expect green `✓ Saved & sent N emails` |

---

## 4. Updating

Push to `main` does **not** auto-redeploy on Portainer (unlike Render). To pull a new version:

- Portainer → Stacks → `production-booking` → **Pull and redeploy**

Or enable Portainer's automatic stack updates (Stacks → edit → toggle "Automatic updates").

---

## 5. Common gotchas

- **`redirect_uri_mismatch` on sign-in** → you forgot to add the new public URL to Google OAuth's authorized redirect URIs.
- **`POSTGRES_PASSWORD: not set` build error** → an env var placeholder isn't filled in. Compose enforces required values via the `?error` syntax.
- **Port `3001` already in use** → pick a different `APP_PORT` in env vars and update `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` accordingly.
- **No nginx in this stack** → put it behind your existing reverse proxy (Traefik, nginx, Caddy, Cloudflare Tunnel, etc.). The local `docker-compose.yml` includes nginx; this one does not.
- **Migrating data from Render** → run `pg_dump` against the Render Postgres and `pg_restore` into the new db container. The Render free DB expires `2026-05-27`.
