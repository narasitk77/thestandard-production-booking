/**
 * One-shot importer for the unified workspace (v1.62.0 phases 2–4 data migration).
 *
 * Pulls the admin's legacy Google Sheets into the new Prisma tables. ONE script
 * with subcommands (shared sheet-reading + header mapping) instead of seven
 * fragile ones. Header-based column mapping tolerates reordering + the sheet's
 * typo headers (QUATITY / Catelogies). DRY-RUN BY DEFAULT — pass --commit to write.
 *
 * Usage:
 *   npx tsx scripts/import-workspace.ts <what> [--commit]
 *   <what> = vendors | equipment | fixed-assets | loans | rentals | purchases | repairs | all
 *
 * Needs the service account (GOOGLE_SERVICE_ACCOUNT_* in .env) to have READ
 * access to both sheets. Override sheet ids / tab names via env if they differ:
 *   EQUIP_SHEET_ID, FINANCE_SHEET_ID, and *_TAB (see DEFAULTS below).
 *
 * If a tab isn't found by its default name, the script case-insensitively
 * matches available tabs and, failing that, prints the tab list and skips.
 */
import { google } from 'googleapis'
import { getSheetsReadAuth } from '../src/lib/google-sheets'
import { prisma } from '../src/lib/db'
import { cleanStr, decOrNull } from '../src/lib/admin-parse'
import type { EquipmentCategory, PaymentStatus, RentalStatus } from '@prisma/client'

const EQUIP_SHEET_ID = process.env.EQUIP_SHEET_ID?.trim() || '1U5YhdsoVcILIQHzY-mdGkkqYBRpddgrazBnR1Ou-Xy4'
const FINANCE_SHEET_ID = process.env.FINANCE_SHEET_ID?.trim() || '1MQMuTq-tkqgQVreyn1sZn-TYvQZFO0cto1SRLi9t59M'

// Defaults match the real tab names discovered via a dry run (Thai year suffixes
// 68=2025, 69=2026). Override any of them via env if the sheets get renamed.
const DEFAULTS = {
  vendorsTab: process.env.VENDORS_TAB || 'Vendor', // matches "VENDOR LIST"
  inventoryTab: process.env.INVENTORY_TAB || 'Production Equipment',
  fixedAssetsTab: process.env.FIXED_ASSETS_TAB || 'Depreciation',
  loansTab: process.env.LOANS_TAB || 'Loans',
  rentalTabs: (process.env.RENTAL_TABS || 'งานเช่า').split(','),
  purchaseTabs: (process.env.PURCHASE_TABS || 'ซื้ออุปกรณ์').split(','),
  repairTabs: (process.env.REPAIR_TABS || 'ซ่อมอุปกรณ์').split(','),
}

const COMMIT = process.argv.includes('--commit')

// ── sheet helpers ─────────────────────────────────────────────────────────────
async function listTabs(sheetId: string): Promise<string[]> {
  const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
  return (meta.data.sheets || []).map((s) => s.properties?.title || '').filter(Boolean)
}

/** Find a real tab title by case-insensitive substring against any of `names`. */
async function resolveTab(sheetId: string, names: string[]): Promise<string | null> {
  const tabs = await listTabs(sheetId)
  for (const want of names) {
    const hit = tabs.find((t) => t.toLowerCase().includes(want.toLowerCase()))
    if (hit) return hit
  }
  return null
}

async function readGrid(sheetId: string, tab: string): Promise<string[][]> {
  const sheets = google.sheets({ version: 'v4', auth: getSheetsReadAuth() })
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'`, valueRenderOption: 'UNFORMATTED_VALUE' })
  return (res.data.values || []).map((r) => (r as any[]).map((c) => (c == null ? '' : String(c))))
}

/** Header index by keyword match (case/space-insensitive contains; first hit wins). */
function colIndex(headers: string[], ...keywords: string[]): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  for (const kw of keywords) {
    const k = norm(kw)
    const i = headers.findIndex((h) => norm(h).includes(k))
    if (i >= 0) return i
  }
  return -1
}
const cell = (row: string[], i: number) => (i >= 0 && i < row.length ? String(row[i]).trim() : '')

/** Tolerant date parse: ISO, DD-Mon-YYYY, DD/MM/YYYY, Thai DD/MM/BBBB (>2500 → -543). */
function parseSheetDate(v: string): Date | null {
  const s = (v || '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  m = s.match(/^(\d{1,2})[-/](\d{1,2}|[A-Za-z]{3,})[-/](\d{2,4})/)
  if (m) {
    const day = parseInt(m[1], 10)
    let mon: number
    if (/^\d+$/.test(m[2])) mon = parseInt(m[2], 10) - 1
    else {
      const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      mon = MON.indexOf(m[2].slice(0, 3).toLowerCase())
    }
    let year = parseInt(m[3], 10)
    if (year < 100) year += 2000
    if (year > 2500) year -= 543 // Thai Buddhist year
    if (mon >= 0 && day >= 1) return new Date(Date.UTC(year, mon, day))
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function mapPayment(v: string): PaymentStatus {
  const s = (v || '').trim()
  if (s.includes('จ่ายแล้ว')) return 'PAID'
  if (s.includes('วางบิล')) return 'INVOICED'
  return 'PENDING'
}

const CAT_MAP: Record<string, EquipmentCategory> = {
  audio: 'AUDIO', camera: 'CAMERA', computer: 'COMPUTER_MONITOR', monitor: 'COMPUTER_MONITOR',
  grip: 'GRIP_SUPPORT', support: 'GRIP_SUPPORT', lens: 'LENS', light: 'LIGHTING',
  power: 'POWER', storage: 'STORAGE_MEDIA', media: 'STORAGE_MEDIA',
}
function mapCategory(v: string): EquipmentCategory {
  const s = (v || '').toLowerCase()
  for (const k of Object.keys(CAT_MAP)) if (s.includes(k)) return CAT_MAP[k]
  return 'UNCATEGORIZED'
}

type Counts = { inserted: number; updated: number; skipped: number; unresolved: number }
const zero = (): Counts => ({ inserted: 0, updated: 0, skipped: 0, unresolved: 0 })
function report(label: string, c: Counts) {
  console.log(`  ${label}: inserted=${c.inserted} updated=${c.updated} skipped=${c.skipped} unresolved=${c.unresolved}`)
}

// ── importers ─────────────────────────────────────────────────────────────────
async function importVendors(): Promise<Counts> {
  const c = zero()
  const tab = await resolveTab(FINANCE_SHEET_ID, [DEFAULTS.vendorsTab])
  if (!tab) { console.warn(`  vendors: tab not found (looked for "${DEFAULTS.vendorsTab}"). Tabs: ${(await listTabs(FINANCE_SHEET_ID)).join(' | ')}`); return c }
  const grid = await readGrid(FINANCE_SHEET_ID, tab)
  const headers = grid[0] || []
  const iName = colIndex(headers, 'vendor', 'name')
  const iSvc = colIndex(headers, 'service')
  const iContact = colIndex(headers, 'contract', 'contact', 'phone')
  const iAcct = colIndex(headers, 'account', 'bank')
  for (const row of grid.slice(1)) {
    const name = cleanStr(cell(row, iName))
    if (!name) { c.skipped++; continue }
    const data = { service: cleanStr(cell(row, iSvc)), contact: cleanStr(cell(row, iContact)), bankAccount: cleanStr(cell(row, iAcct)) }
    if (COMMIT) {
      const existing = await prisma.vendor.findUnique({ where: { name } })
      if (existing) { await prisma.vendor.update({ where: { name }, data }); c.updated++ }
      else { await prisma.vendor.create({ data: { name, ...data } }); c.inserted++ }
    } else c.inserted++
  }
  return c
}

async function importEquipment(): Promise<Counts> {
  const c = zero()
  const tab = await resolveTab(EQUIP_SHEET_ID, [DEFAULTS.inventoryTab])
  if (!tab) { console.warn(`  equipment: tab not found. Tabs: ${(await listTabs(EQUIP_SHEET_ID)).join(' | ')}`); return c }
  const grid = await readGrid(EQUIP_SHEET_ID, tab)
  const headers = grid[0] || []
  const iId = colIndex(headers, 'itemid', 'item id')
  const iName = colIndex(headers, 'name')
  const iDesc = colIndex(headers, 'description')
  const iSn = colIndex(headers, 's/n', 'serial')
  const iLoc = colIndex(headers, 'location')
  const iCat = colIndex(headers, 'category', 'catelog')
  const iTag = colIndex(headers, 'fixed_asset', 'asset_tag', 'asset tag')
  for (const row of grid.slice(1)) {
    const name = cleanStr(cell(row, iName))
    if (!name) { c.skipped++; continue }
    const itemId = cleanStr(cell(row, iId))
    const data = {
      name, description: cleanStr(cell(row, iDesc)), serialNumber: cleanStr(cell(row, iSn)),
      location: cleanStr(cell(row, iLoc)), category: mapCategory(cell(row, iCat)),
      fixedAssetTag: cleanStr(cell(row, iTag)), loanable: true, isFixedAsset: false,
    }
    if (COMMIT) {
      if (itemId) {
        const existing = await prisma.equipment.findUnique({ where: { itemId } })
        if (existing) { await prisma.equipment.update({ where: { itemId }, data }); c.updated++ }
        else { await prisma.equipment.create({ data: { itemId, ...data } }); c.inserted++ }
      } else { await prisma.equipment.create({ data }); c.inserted++ }
    } else c.inserted++
  }
  return c
}

async function importFixedAssets(): Promise<Counts> {
  const c = zero()
  const tab = await resolveTab(EQUIP_SHEET_ID, [DEFAULTS.fixedAssetsTab])
  if (!tab) { console.warn(`  fixed-assets: tab not found. Tabs: ${(await listTabs(EQUIP_SHEET_ID)).join(' | ')}`); return c }
  const grid = await readGrid(EQUIP_SHEET_ID, tab)
  // This tab has no header row in the export (name | assetId | category | value).
  for (const row of grid) {
    const name = cleanStr(cell(row, 0))
    const tag = cleanStr(cell(row, 1))
    if (!name || !tag || /^(name|asset)/i.test(name)) { c.skipped++; continue }
    const data = {
      name, fixedAssetTag: tag, isFixedAsset: true, loanable: false,
      category: 'UNCATEGORIZED' as EquipmentCategory,
      depreciationNote: cleanStr(`${cell(row, 2)} ${cell(row, 3)}`.trim()),
      purchasePrice: decOrNull(cell(row, 3)),
    }
    if (COMMIT) {
      const existing = await prisma.equipment.findFirst({ where: { fixedAssetTag: tag, isFixedAsset: true } })
      if (existing) { await prisma.equipment.update({ where: { id: existing.id }, data }); c.updated++ }
      else { await prisma.equipment.create({ data }); c.inserted++ }
    } else c.inserted++
  }
  return c
}

async function importLoans(): Promise<Counts> {
  const c = zero()
  const tab = await resolveTab(EQUIP_SHEET_ID, [DEFAULTS.loansTab])
  if (!tab) { console.warn(`  loans: tab not found. Tabs: ${(await listTabs(EQUIP_SHEET_ID)).join(' | ')}`); return c }
  const grid = await readGrid(EQUIP_SHEET_ID, tab)
  const headers = grid[0] || []
  const iCode = colIndex(headers, 'loanid', 'loan id', 'loancode')
  const iPhoto = colIndex(headers, 'photographer')
  const iEmail = colIndex(headers, 'email')
  const iJob = colIndex(headers, 'jobname', 'job name')
  const iDue = colIndex(headers, 'duedate', 'due')
  const iBorrowed = colIndex(headers, 'borrowedat', 'borrowed')
  const iReturned = colIndex(headers, 'returnedat', 'returned')
  const iStatus = colIndex(headers, 'status')
  const iItems = colIndex(headers, 'items')
  for (const row of grid.slice(1)) {
    const loanCode = cleanStr(cell(row, iCode))
    const photographer = cleanStr(cell(row, iPhoto))
    if (!loanCode || !photographer) { c.skipped++; continue }
    let items: Array<{ equipmentId: string | null; nameSnapshot: string; tagSnapshot: string | null }> = []
    try {
      const raw = cell(row, iItems)
      const arr = raw ? JSON.parse(raw) : []
      for (const it of arr) {
        const tag = cleanStr(it.tag)
        let equipmentId: string | null = null
        if (COMMIT) {
          const eq = await prisma.equipment.findFirst({ where: { OR: [{ itemId: it.id }, ...(tag ? [{ fixedAssetTag: tag }] : [])] }, select: { id: true } })
          equipmentId = eq?.id || null
        }
        items.push({ equipmentId, nameSnapshot: cleanStr(it.name) || it.id || 'unknown', tagSnapshot: tag })
      }
    } catch { c.unresolved++ }
    const status = /return/i.test(cell(row, iStatus)) ? 'RETURNED' : 'ACTIVE'
    const data = {
      photographer, email: cleanStr(cell(row, iEmail)), jobName: cleanStr(cell(row, iJob)),
      dueDate: parseSheetDate(cell(row, iDue)), borrowedAt: parseSheetDate(cell(row, iBorrowed)),
      returnedAt: parseSheetDate(cell(row, iReturned)), status: status as 'ACTIVE' | 'RETURNED',
    }
    if (COMMIT) {
      const existing = await prisma.equipmentLoan.findUnique({ where: { loanCode } })
      if (existing) { await prisma.equipmentLoan.update({ where: { loanCode }, data }); c.updated++ }
      else {
        await prisma.equipmentLoan.create({ data: { loanCode, ...data, items: { create: items } } })
        c.inserted++
      }
    } else c.inserted++
  }
  return c
}

async function importRentals(): Promise<Counts> {
  const c = zero()
  const tabs = (await listTabs(FINANCE_SHEET_ID)).filter((t) => DEFAULTS.rentalTabs.some((n) => t.toLowerCase().includes(n.toLowerCase())))
  if (!tabs.length) { console.warn(`  rentals: no matching tabs. Tabs: ${(await listTabs(FINANCE_SHEET_ID)).join(' | ')}`); return c }
  for (const tab of tabs) {
    const archived = /return|archive/i.test(tab)
    const grid = await readGrid(FINANCE_SHEET_ID, tab)
    const headers = grid[0] || []
    const iQuote = colIndex(headers, 'qu', 'quote')
    const iType = colIndex(headers, 'ประเภท', 'type')
    const iJob = colIndex(headers, 'ชื่องาน', 'job')
    const iDate = colIndex(headers, 'วันที่เช่า', 'rental date', 'date')
    const iOutlet = colIndex(headers, 'outlet')
    const iVendor = colIndex(headers, 'vendor')
    const iStatus = colIndex(headers, 'status', 'สถานะ')
    const iInv = colIndex(headers, 'เลขที่ใบแจ้งหนี้', 'invoice')
    const iAmt = colIndex(headers, 'ยอดใบแจ้งหนี้', 'amount', 'ยอด')
    for (const row of grid.slice(1)) {
      const jobName = cleanStr(cell(row, iJob))
      const quoteNo = cleanStr(cell(row, iQuote))
      if (!jobName && !quoteNo) { c.skipped++; continue }
      const rentalDate = parseSheetDate(cell(row, iDate))
      const data = {
        quoteNo, adType: cleanStr(cell(row, iType)), jobName, rentalDate,
        paymentStatus: mapPayment(cell(row, iStatus)),
        invoiceNo: cleanStr(cell(row, iInv)), amount: decOrNull(cell(row, iAmt)),
        status: (archived ? 'ARCHIVED' : 'ACTIVE') as RentalStatus,
        vendorId: COMMIT ? (await prisma.vendor.findFirst({ where: { name: cleanStr(cell(row, iVendor)) || '___none' }, select: { id: true } }))?.id || null : null,
        outletId: COMMIT ? (await prisma.outlet.findFirst({ where: { OR: [{ code: cleanStr(cell(row, iOutlet)) || '___' }, { name: { contains: cleanStr(cell(row, iOutlet)) || '___', mode: 'insensitive' } }] }, select: { id: true } }))?.id || null : null,
      }
      if (COMMIT) {
        const existing = await prisma.rentalJob.findFirst({ where: { jobName: jobName || undefined, quoteNo: quoteNo || undefined, rentalDate: rentalDate || undefined } })
        if (existing) { await prisma.rentalJob.update({ where: { id: existing.id }, data }); c.updated++ }
        else { await prisma.rentalJob.create({ data }); c.inserted++ }
      } else c.inserted++
    }
  }
  return c
}

async function importPurchases(): Promise<Counts> {
  const c = zero()
  const tabs = (await listTabs(FINANCE_SHEET_ID)).filter((t) => DEFAULTS.purchaseTabs.some((n) => t.toLowerCase().includes(n.toLowerCase())))
  if (!tabs.length) { console.warn(`  purchases: no matching tabs. Tabs: ${(await listTabs(FINANCE_SHEET_ID)).join(' | ')}`); return c }
  for (const tab of tabs) {
    const grid = await readGrid(FINANCE_SHEET_ID, tab)
    const headers = grid[0] || []
    const iMonth = colIndex(headers, 'เดือน', 'month')
    const iItem = colIndex(headers, 'รายการ', 'item')
    const iQty = colIndex(headers, 'จำนวน', 'qty', 'quantity')
    const iVendor = colIndex(headers, 'ซื้อจาก', 'vendor', 'from')
    const iLink = colIndex(headers, 'link')
    const iUnit = colIndex(headers, 'ราคาต่อหน่วย', 'unit')
    const iTotal = colIndex(headers, 'ราคารวม', 'total')
    const iKind = colIndex(headers, 'remark', 'kind')
    for (const row of grid.slice(1)) {
      const item = cleanStr(cell(row, iItem))
      if (!item) { c.skipped++; continue }
      const month = cleanStr(cell(row, iMonth))
      const total = decOrNull(cell(row, iTotal))
      const data = {
        month, item, quantity: parseInt(cell(row, iQty), 10) || 1,
        productLink: cleanStr(cell(row, iLink)), unitPrice: decOrNull(cell(row, iUnit)), total,
        kind: cleanStr(cell(row, iKind)),
        vendorId: COMMIT ? (await prisma.vendor.findFirst({ where: { name: cleanStr(cell(row, iVendor)) || '___' }, select: { id: true } }))?.id || null : null,
      }
      if (COMMIT) {
        const existing = await prisma.purchaseItem.findFirst({ where: { item, month: month || undefined, total: total ? (total as any) : undefined } })
        if (existing) { await prisma.purchaseItem.update({ where: { id: existing.id }, data }); c.updated++ }
        else { await prisma.purchaseItem.create({ data }); c.inserted++ }
      } else c.inserted++
    }
  }
  return c
}

async function importRepairs(): Promise<Counts> {
  const c = zero()
  const tabs = (await listTabs(FINANCE_SHEET_ID)).filter((t) => DEFAULTS.repairTabs.some((n) => t.toLowerCase().includes(n.toLowerCase())))
  if (!tabs.length) { console.warn(`  repairs: no matching tabs. Tabs: ${(await listTabs(FINANCE_SHEET_ID)).join(' | ')}`); return c }
  for (const tab of tabs) {
    const grid = await readGrid(FINANCE_SHEET_ID, tab)
    const headers = grid[0] || []
    const iMonth = colIndex(headers, 'เดือน', 'month')
    const iItem = colIndex(headers, 'รายการ', 'item')
    const iCost = colIndex(headers, 'ราคารวม', 'total', 'cost')
    const iKind = colIndex(headers, 'remark', 'kind')
    for (const row of grid.slice(1)) {
      const itemLabel = cleanStr(cell(row, iItem))
      if (!itemLabel || /^รวม$/.test(itemLabel)) { c.skipped++; continue } // skip subtotal rows
      const cost = decOrNull(cell(row, iCost))
      const month = cleanStr(cell(row, iMonth))
      const data = { itemLabel, cost, kind: cleanStr(cell(row, iKind)), remark: month ? `เดือน ${month}` : null, status: 'RETURNED' as const }
      if (COMMIT) {
        const existing = await prisma.repairTicket.findFirst({ where: { itemLabel, cost: cost ? (cost as any) : undefined } })
        if (existing) { await prisma.repairTicket.update({ where: { id: existing.id }, data }); c.updated++ }
        else { await prisma.repairTicket.create({ data }); c.inserted++ }
      } else c.inserted++
    }
  }
  return c
}

const IMPORTERS: Record<string, () => Promise<Counts>> = {
  vendors: importVendors,
  equipment: importEquipment,
  'fixed-assets': importFixedAssets,
  loans: importLoans,
  rentals: importRentals,
  purchases: importPurchases,
  repairs: importRepairs,
}
// Sensible order for "all": vendors first (rentals/purchases/repairs FK to them),
// equipment before loans (loans resolve equipmentId).
const ALL_ORDER = ['vendors', 'equipment', 'fixed-assets', 'loans', 'rentals', 'purchases', 'repairs']

async function main() {
  const what = process.argv[2]
  if (!what || (!IMPORTERS[what] && what !== 'all')) {
    console.error(`Usage: npx tsx scripts/import-workspace.ts <${ALL_ORDER.join('|')}|all> [--commit]`)
    process.exit(1)
  }
  console.log(`=== Workspace import: ${what} ${COMMIT ? '(COMMIT — writing)' : '(DRY RUN — pass --commit to write)'} ===`)
  const targets = what === 'all' ? ALL_ORDER : [what]
  for (const t of targets) {
    try {
      const counts = await IMPORTERS[t]()
      report(t, counts)
    } catch (e: any) {
      console.error(`  ${t}: FAILED — ${e?.message || e}`)
      if (e?.code === 403 || /permission/i.test(String(e?.message))) {
        console.error('    → share the sheet with GOOGLE_SERVICE_ACCOUNT_EMAIL (read access).')
      }
    }
  }
  await prisma.$disconnect()
  console.log('Done.')
}

main()
