/* Pure stepping math for NumberStepper, split out so it can be unit-tested
   without React. Values are strings ('' = empty/unset). */

export const clampCount = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n))

/** Parse a stepper string to a number, or null when empty/invalid. */
export const parseCount = (value: string): number | null => {
  const n = parseInt(value, 10)
  return Number.isNaN(n) ? null : n
}

/**
 * Apply a +1 / −1 button press. From an empty field, +1 lands on the first
 * sensible count (min, or 1 when min is 0) and −1 lands on min; otherwise the
 * current value is nudged and clamped to [min, max].
 */
export const stepCount = (value: string, delta: number, min: number, max: number): string => {
  const cur = parseCount(value)
  if (cur == null) return String(clampCount(delta > 0 ? Math.max(min, 1) : min, min, max))
  return String(clampCount(cur + delta, min, max))
}

/**
 * Normalize on blur. A non-empty value is clamped; an empty value stays empty
 * when allowEmpty, otherwise snaps to min (for required-with-default counts).
 */
export const blurCount = (value: string, min: number, max: number, allowEmpty: boolean): string => {
  const cur = parseCount(value)
  if (cur == null) return allowEmpty ? '' : String(min)
  return String(clampCount(cur, min, max))
}
