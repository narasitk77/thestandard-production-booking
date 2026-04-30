# THE STANDARD — Production Booking

> ระบบ Booking การผลิต | Episode ID auto-generation | Calendar Packet for Coordinator

**Live**: https://production-booking-app.onrender.com  
**Version**: 1.2.0 · **Phase**: 1

---

## What it does

Producer กรอก Booking ครั้งเดียว → ระบบ generate Episode ID → สร้าง Calendar Packet ให้พี่ตุ้ย copy-paste

| Feature | Detail |
|---------|--------|
| Booking form | Google Form-style, single page, cascade dropdowns |
| Outlets | 9 outlets (NWS, WLT, SPT, POP, POD, KND, LIF, TSS, AGN) |
| Programs | 56 programs, dropdown filtered by outlet |
| Episode ID | `[OUT]-[YYMMDD]-[PROG]-[EE]` e.g. `TSS-260423-EXE-01` |
| Calendar Packet | Auto-generated, copy-paste ready for coordinator |
| Dashboard | Search, filter by outlet/status, booking detail |
| Upload platform | Log footage by Episode ID + camera slot |

## Episode ID Rules

```
TSS  -  260423  -  EXE  -  01
 │         │        │       │
OUT    YYMMDD    PROG    Sequence
```

1. **Immutable** — never rename after creation
2. **Folder-only** — ID on folder name only; files keep original camera names

## Pages

| URL | Description |
|-----|-------------|
| `/` | Booking form (Google Form style) |
| `/booking/success` | Confirmation + Episode IDs + Calendar Packet |
| `/dashboard` | All bookings — search, filter, manage |
| `/dashboard/[id]` | Booking detail + status actions + upload log |
| `/upload` | Footage upload — log files by Episode ID + camera |

## Local Development

```bash
# 1. Copy env
cp .env.example .env
# Edit DATABASE_URL

# 2. Install + setup DB
npm install
npx prisma db push
npx tsx prisma/seed.ts

# 3. Run
npm run dev
```

Open http://localhost:3000

## Docker / Portainer

```bash
cp .env.production .env
# Edit POSTGRES_PASSWORD and NEXT_PUBLIC_APP_URL

docker compose up -d
```

Container auto-runs `prisma db push` + seed on every boot (idempotent).

Services: `app` (port 3000) · `nginx` (port 80) · `db` (PostgreSQL 16, internal)

## Render Deployment

Push to `main` → Render auto-deploys.

- Web service: `srv-d7ng9kdckfvc73evd6j0`
- PostgreSQL: `dpg-d7neua57vvec739364k0-a` (free tier — **expires 2026-05-27**)
- Region: Singapore

### Email Delivery

Render free web services block outbound SMTP ports `25`, `465`, and `587`.

The app can send through the logged-in admin's Google account using the Gmail HTTPS API. After this scope is deployed, admins must sign out and sign in once to grant Gmail send permission.

Optional provider-based delivery is also supported:

Supported providers:

```bash
# Recommended on Render free
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxx
EMAIL_FROM="THE STANDARD Production Booking <production@thestandard.co>"

# Alternative
EMAIL_PROVIDER=sendgrid
SENDGRID_API_KEY=SG.xxx
EMAIL_FROM="THE STANDARD Production Booking <production@thestandard.co>"
```

SMTP is still supported where outbound SMTP is allowed, or when using a provider port such as `2525`.

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 · TypeScript · App Router |
| Database | PostgreSQL 16 · Prisma ORM |
| Styling | Tailwind CSS (Google Form aesthetic) |
| Container | Docker · docker-compose · Nginx |
| Hosting | Render (Singapore) |

## Outlets & Programs

| Code | Name | Programs |
|------|------|----------|
| NWS | News | 8 |
| WLT | Wealth | 5 |
| SPT | Sport | 4 |
| POP | POP | 8 |
| POD | Podcast | 5 |
| KND | คำนี้ดี | 3 |
| LIF | LIFE | 5 |
| TSS | The Secret Sauce | 14 |
| AGN | Content Agency | 3 |

## Roadmap (Phase 2+)

- [ ] Airtable API push (auto-create Production Projects record)
- [ ] Google Calendar event packet (direct API, not copy-paste)
- [ ] Shot Log for multi-program exceptions (Event cards)
- [ ] Bulk + resumable footage upload
- [ ] Proxy workflow & MAM-native search
- [ ] Delivery tracker dashboard

---

See [CHANGELOG.md](CHANGELOG.md) for version history.
