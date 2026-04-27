# THE STANDARD — Production Booking Platform

> Production Pipeline: Booking → Episode ID → Calendar → Drive/NAS → Mimir

**Version**: 1.0.0 · **Phase**: 1 · **Owner**: ปุ๊ก

---

## What This Does

Single-entry booking system that auto-generates structured Episode IDs and calendar packets for THE STANDARD video production team.

- **Menu page** — 9 outlet entry points (NWS, WLT, SPT, POP, POD, KND, LIF, TSS, AGN)
- **Booking form** — 16 fields, conditional logic, dropdown-locked
- **Episode ID generation** — `[OUT]-[YYMMDD]-[PROG]-[EE]` (e.g. `TSS-260423-EXE-01`)
- **Calendar packet** — copy-paste ready for Production Coordinator (พี่ตุ้ย)
- **Dashboard** — coordinator view of all bookings
- **Upload platform** — footage logging by Episode ID + camera slot

## Episode ID Format

```
TSS  -  260423  -  EXE  -  01
 │         │        │       │
OUT    YYMMDD    PROG     Sequence
```

**Rules:**
1. **Immutable** — never rename after creation
2. **Folder-only policy** — ID on folder name, files keep original camera names

## Quick Start (Local)

```bash
cp .env.example .env
# Edit .env with your database credentials

npm install
npx prisma db push
npm run db:seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Docker (Portainer)

```bash
cp .env.production .env
# Edit .env — set POSTGRES_PASSWORD and NEXT_PUBLIC_APP_URL

docker compose up -d
```

The `migrate` service runs automatically on first start to create tables and seed the 56 programs.

Services:
- **app** → port 3000 (Next.js)
- **nginx** → port 80 (reverse proxy)
- **db** → PostgreSQL 16 (internal only)

## Portainer Deployment

1. In Portainer → Stacks → Add Stack
2. Upload `docker-compose.yml` or paste its contents
3. Add environment variables from `.env.production`
4. Deploy

## Project Structure

```
src/
├── app/
│   ├── page.tsx                # Menu — 9 outlet cards
│   ├── booking/[outlet]/       # Per-outlet booking form
│   ├── booking/success/        # Confirmation + calendar packet
│   ├── dashboard/              # Coordinator booking list
│   ├── dashboard/[id]/         # Booking detail + actions
│   ├── upload/                 # Footage upload (MVP)
│   └── api/
│       ├── bookings/           # CRUD + Episode ID generation
│       └── upload/             # Multipart file upload
├── lib/
│   ├── data.ts                 # 9 outlets × 56 programs master data
│   ├── episode-id.ts           # ID generator function
│   ├── utils.ts                # Formatters + calendar packet builder
│   └── db.ts                   # Prisma singleton
prisma/
│   ├── schema.prisma           # DB schema
│   └── seed.ts                 # Seed outlets + programs
```

## Outlets & Programs (56 total)

| Code | Outlet | Programs |
|------|--------|----------|
| NWS | News | 8 |
| WLT | Wealth | 5 |
| SPT | Sport | 4 |
| POP | POP | 8 |
| POD | Podcast | 5 |
| KND | คำนี้ดี | 3 |
| LIF | LIFE | 5 |
| TSS | The Secret Sauce | 14 |
| AGN | Content Agency | 3 |

## Tech Stack

- **Framework**: Next.js 14 (App Router, TypeScript)
- **Database**: PostgreSQL + Prisma ORM
- **Styling**: Tailwind CSS
- **Container**: Docker + docker-compose
- **Proxy**: Nginx

## Phase 2+ Roadmap

- [ ] Shot Log for multi-program cards (Event exception)
- [ ] Cascade dropdown upgrade (Apps Script Web App)
- [ ] Bulk upload + resumable upload
- [ ] Airtable API push
- [ ] Google Calendar event creation
- [ ] Proxy workflow + MAM-native search
- [ ] Delivery tracker dashboard
