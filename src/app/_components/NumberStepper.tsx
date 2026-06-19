'use client'

import { Minus, Plus } from 'lucide-react'
import { parseCount, stepCount, blurCount } from '@/lib/number-stepper'

/* NumberStepper — −/type/+ count input. Controlled on a STRING value so the
   field can be cleared and retyped (the old `type=number` + `parseInt()||1`
   onChange snapped back to 1 on every keystroke → impossible to type on mobile).
   Buttons give big tap targets; the input uses inputMode=numeric (numeric
   keypad on phones) and text-base (≥16px stops iOS auto-zoom). Empty is allowed
   while editing; the value is clamped to [min,max] on blur and on button press. */
export default function NumberStepper({
  value,
  onChange,
  min = 0,
  max = 99,
  allowEmpty = true,
  ariaLabel,
  id,
  invalid,
  placeholder,
  className = '',
}: {
  value: string
  onChange: (next: string) => void
  min?: number
  max?: number
  allowEmpty?: boolean // false → blur on an empty field snaps to min (for required-with-default counts)
  ariaLabel?: string
  id?: string
  invalid?: boolean
  placeholder?: string
  className?: string
}) {
  const cur = parseCount(value)
  const step = (delta: number) => onChange(stepCount(value, delta, min, max))
  const atMin = cur != null && cur <= min
  const atMax = cur != null && cur >= max
  const btn =
    'flex items-center justify-center w-11 h-11 shrink-0 rounded-lg border border-gray-300 text-gray-600 ' + // 44px = mobile tap-target min
    'hover:border-brand-primary hover:text-brand-primary active:scale-95 transition ' +
    'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-gray-300 disabled:hover:text-gray-600'

  return (
    <div className={`flex items-stretch gap-1.5 ${className}`}>
      <button type="button" aria-label={ariaLabel ? `ลด ${ariaLabel}` : 'ลด'} disabled={atMin} onClick={() => step(-1)} className={btn}>
        <Minus className="w-4 h-4" />
      </button>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => onChange(blurCount(value, min, max, allowEmpty))}
        className={`w-full min-w-0 text-center tabular-nums h-11 px-2 rounded-lg border text-base focus:outline-none focus:border-brand-primary ${
          invalid ? 'border-red-400 bg-red-50' : 'border-gray-300'
        }`}
      />
      <button type="button" aria-label={ariaLabel ? `เพิ่ม ${ariaLabel}` : 'เพิ่ม'} disabled={atMax} onClick={() => step(1)} className={btn}>
        <Plus className="w-4 h-4" />
      </button>
    </div>
  )
}
