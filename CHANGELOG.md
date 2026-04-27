# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.2.0] — 2026-04-27

### Changed
- **UI redesign**: replaced outlet-card grid with a single Google Form-style booking page
- Outlet and Program are now cascade dropdowns on one page (no more per-outlet subpages)
- Removed Episode ID explainer section from homepage
- Dashboard re-styled to match Google Form aesthetic (clean white tables)
- Navigation simplified to top bar with Dashboard + Upload Footage links

### Removed
- Multi-card outlet selection landing page
- Step-by-step Episode ID decoder block
- Heavy brand-color card grid

---

## [1.1.0] — 2026-04-27

### Fixed
- Dockerfile: switched from multi-stage standalone to single-stage build (`npm install` instead of `npm ci --frozen-lockfile`) — resolves build failure due to missing `package-lock.json`
- Removed `output: 'standalone'` from `next.config.js` — simplifies server startup
- Removed Thai locale import from `date-fns` — resolves build-time module error
- `start.sh`: use `prisma db push` + `tsx seed` before `npm start`

### Added
- `start.sh`: auto-runs DB schema sync + seed on every container boot (idempotent)
- Dockerfile copies Prisma CLI + tsx into image for runtime migrations

---

## [1.0.0] — 2026-04-27

### Added
- Initial release: THE STANDARD Production Booking Platform
- **Menu page** with 9 outlet cards (NWS, WLT, SPT, POP, POD, KND, LIF, TSS, AGN)
- **Booking form** — 16 fields, conditional logic (location if not studio, agency ref if agency job)
- **Episode ID auto-generation** — format `[OUT]-[YYMMDD]-[PROG]-[EE]`, immutable, folder-only policy
- **Confirmation page** with Calendar Packet copy-paste ready for Production Coordinator (พี่ตุ้ย)
- **Dashboard** — list all bookings, filter by outlet/status, search by Episode ID
- **Booking detail** — status management (Pending → Confirmed → Completed), calendar packet, Drive folder path
- **Upload platform MVP** — footage logging by Episode ID + camera slot (Cam1–Cam4, Sound, Drone, BTS)
- **PostgreSQL + Prisma** schema: Outlet, Program, Booking, Episode, Upload models
- **Seed data**: 9 outlets × 56 programs from master spreadsheet
- **Docker + docker-compose**: app + PostgreSQL + Nginx reverse proxy, Portainer-ready
- **Render deployment**: web service + PostgreSQL, Singapore region, auto-deploy from GitHub
