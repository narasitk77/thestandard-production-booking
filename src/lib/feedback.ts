/**
 * v1.166 — feedback ticket helpers (pure; the route and both UIs share them).
 */

export const FEEDBACK_STATUSES = ['NEW', 'IN_PROGRESS', 'RESOLVED'] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export function isFeedbackStatus(v: unknown): v is FeedbackStatus {
  return typeof v === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(v)
}

/** FB-001. Zero-padded to 3 so early tickets sort and read like the later ones. */
export function ticketRef(n: number): string {
  return `FB-${String(n).padStart(3, '0')}`
}

export const STATUS_TH: Record<FeedbackStatus, string> = {
  NEW: 'ใหม่',
  IN_PROGRESS: 'กำลังแก้',
  RESOLVED: 'แก้เสร็จ',
}

export const MOOD_TH: Record<string, string> = {
  love: '😊 ชอบเลย',
  problem: '😖 เจอปัญหา',
  idea: '💡 มีไอเดีย',
}

/**
 * A reporter replying to a RESOLVED ticket reopens it — the alternative is a
 * closed ticket nobody looks at while the person is still stuck.
 */
export function statusAfterReporterReply(current: string): FeedbackStatus {
  return current === 'RESOLVED' ? 'IN_PROGRESS' : (isFeedbackStatus(current) ? current : 'NEW')
}

/** An admin replying to a NEW ticket has, by replying, picked it up. */
export function statusAfterAdminReply(current: string): FeedbackStatus {
  return current === 'NEW' ? 'IN_PROGRESS' : (isFeedbackStatus(current) ? current : 'IN_PROGRESS')
}
