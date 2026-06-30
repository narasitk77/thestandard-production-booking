'use client'

/* =============================================================================
   Shared status badges + Thai labels for the Production Admin Space (inventory
   control). One source of truth so every module table — and the dashboard —
   render the same colour + wording for each enum value.
   ============================================================================= */

const C = {
  gray: 'bg-gray-100 text-gray-600',
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-700',
} as const

type Entry = { th: string; c: string }
export type BadgeMap = Record<string, Entry>

// Equipment lifecycle: AVAILABLE → ON_LOAN/IN_REPAIR → AVAILABLE, RETIRED = end.
export const EQUIP_STATUS: BadgeMap = {
  AVAILABLE: { th: 'พร้อมใช้', c: C.green },
  ON_LOAN: { th: 'ถูกยืม', c: C.amber },
  IN_REPAIR: { th: 'กำลังซ่อม', c: C.red },
  RETIRED: { th: 'ปลดระวาง', c: C.gray },
}

export const LOAN_STATUS: BadgeMap = {
  REQUESTED: { th: 'ขอเบิก', c: C.blue },
  ACTIVE: { th: 'ยืมอยู่', c: C.amber },
  RETURNED: { th: 'คืนแล้ว', c: C.gray },
  OVERDUE: { th: 'เกินกำหนด', c: C.red }, // derived (ACTIVE + dueDate < today)
}

export const REPAIR_STATUS: BadgeMap = {
  REPORTED: { th: 'แจ้งซ่อม', c: C.amber },
  SENT: { th: 'ส่งซ่อม', c: C.blue },
  RETURNED: { th: 'ซ่อมเสร็จ', c: C.green },
  CANNOT_REPAIR: { th: 'ซ่อมไม่ได้', c: C.gray },
}

export const RENTAL_STATUS: BadgeMap = {
  ACTIVE: { th: 'กำลังเช่า', c: C.blue },
  RETURNED: { th: 'คืนแล้ว', c: C.gray },
  ARCHIVED: { th: 'เก็บแล้ว', c: C.gray },
}

export const PAYMENT_STATUS: BadgeMap = {
  PAID: { th: 'จ่ายแล้ว', c: C.green },
  INVOICED: { th: 'วางบิล', c: C.amber },
  PENDING: { th: 'รอจ่าย', c: C.red },
}

export const PURCHASE_STATUS: BadgeMap = {
  DRAFT: { th: 'ร่าง', c: C.gray },
  SUBMITTED: { th: 'รออนุมัติ', c: C.amber },
  APPROVED: { th: 'อนุมัติแล้ว', c: C.green },
  REJECTED: { th: 'ไม่อนุมัติ', c: C.red },
}

export const CATEGORY_TH: Record<string, string> = {
  AUDIO: 'เสียง',
  CAMERA: 'กล้อง',
  COMPUTER_MONITOR: 'คอม/จอ',
  GRIP_SUPPORT: 'ขาตั้ง/ริก',
  LENS: 'เลนส์',
  LIGHTING: 'ไฟ',
  POWER: 'ไฟ/แบต',
  STORAGE_MEDIA: 'สื่อบันทึก',
  UNCATEGORIZED: 'ไม่ระบุ',
}

export function Badge({ map, value }: { map: BadgeMap; value: string | null | undefined }) {
  if (!value) return <span className="text-gray-300">—</span>
  const e = map[value]
  return (
    <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${e?.c || C.gray}`}>
      {e?.th || value}
    </span>
  )
}
