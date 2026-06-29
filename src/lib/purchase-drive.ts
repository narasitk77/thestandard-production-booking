import { ensureFolderPath } from './google-drive'
import { safeFolderSegment } from './purchase-batch'

// Receipts file themselves by month → item under DRIVE_DOCS_ROOT, so the buyer
// can hand the manager a single tidy month folder. Same Thai category label the
// documents UI already uses.
export const PURCHASE_CATEGORY_FOLDER = 'จัดซื้อ (Purchases)'

export function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`
}

function docsRoot(): string {
  const root = process.env.DRIVE_DOCS_ROOT?.trim()
  if (!root) throw new Error('ยังไม่ได้ตั้งค่า DRIVE_DOCS_ROOT (โฟลเดอร์ปลายทางใน Drive)')
  return root
}

/** จัดซื้อ / <YYYY-MM> — the month folder. Returns its Drive id. */
export function ensurePurchaseMonthFolder(month: string): Promise<string> {
  return ensureFolderPath(docsRoot(), [PURCHASE_CATEGORY_FOLDER, month])
}

/** จัดซื้อ / <YYYY-MM> / <item> — one item's subfolder (receipts go here). */
export function ensurePurchaseItemFolder(month: string, item: string, fallbackId: string): Promise<string> {
  return ensureFolderPath(docsRoot(), [PURCHASE_CATEGORY_FOLDER, month, safeFolderSegment(item, fallbackId)])
}
