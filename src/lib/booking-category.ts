import type { Category } from '@prisma/client'

/**
 * Resolve the booking-level Category (v1.98.0).
 *
 * The booking-level Category radio was removed from the wizard for non-AGN
 * outlets — it duplicated the per-episode contentType. So for non-AGN we derive
 * booking.category from the episodes: any Advertorial episode makes the whole
 * booking ADVERTORIAL, otherwise ORIGINAL_CONTENT.
 *
 * Content Agency (AGN) keeps an explicit category — it has no per-episode
 * contentType and the value drives AGN Drive folder routing (ADVERTORIAL →
 * "Advertorial", EVENT → "Event / Forum"). booking.category is a non-null enum,
 * so this always returns a valid value.
 */
export function deriveBookingCategory(
  isAgency: boolean,
  explicitCategory: Category,
  episodes: ReadonlyArray<{ contentType?: string | null }>,
): Category {
  if (isAgency) return explicitCategory
  return episodes.some(e => e.contentType === 'ADVERTORIAL') ? 'ADVERTORIAL' : 'ORIGINAL_CONTENT'
}
