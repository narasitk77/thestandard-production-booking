'use client'

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

// Logical drawing dimensions. The DOM element is sized responsively via CSS
// (max-width: 100%, aspect ratio preserved), but the backing canvas always
// uses these pixel dimensions so the exported PNG is predictable regardless
// of the screen we drew on.
const W = 600
const H = 200

// Stroke style — black ink, medium thickness. Mimics a felt-tip pen so the
// PNG embeds cleanly into both the UI and the PDF cover sheet.
const STROKE_COLOR = '#111827'
const STROKE_WIDTH = 2.5

export interface SignaturePadHandle {
  /** Return the current drawing as a PNG data URL, or null if blank. */
  toDataUrl(): string | null
  /** Clear the canvas and reset the dirty flag. */
  clear(): void
  /** True if the user has drawn at least one stroke since the last clear. */
  isDirty(): boolean
}

interface Props {
  /**
   * Pre-fill the pad with an existing PNG data URL (e.g. user's saved
   * signature). The image is drawn once on mount and again whenever this
   * prop reference changes. Pass `null` for a blank pad.
   */
  initialDataUrl?: string | null
  /** Fires every time a stroke ends, with the current PNG data URL. */
  onChange?: (dataUrl: string) => void
  className?: string
}

/**
 * Mouse + touch signature pad. Internally tracks pointer state and renders
 * quadratic-smoothed curves between sampled points. Parents grab the final
 * image via the ref handle (toDataUrl) or via onChange.
 */
const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad(
  { initialDataUrl, onChange, className = '' },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const dirtyRef = useRef(false)
  const [hasContent, setHasContent] = useState(!!initialDataUrl)

  const getCtx = useCallback(() => {
    const c = canvasRef.current
    if (!c) return null
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = STROKE_COLOR
    ctx.lineWidth = STROKE_WIDTH
    return ctx
  }, [])

  const wipeCanvas = useCallback(() => {
    const c = canvasRef.current
    const ctx = getCtx()
    if (!c || !ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
  }, [getCtx])

  const drawInitial = useCallback((dataUrl: string) => {
    const ctx = getCtx()
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      wipeCanvas()
      ctx.drawImage(img, 0, 0, W, H)
      setHasContent(true)
    }
    img.src = dataUrl
  }, [getCtx, wipeCanvas])

  useEffect(() => {
    if (initialDataUrl) {
      drawInitial(initialDataUrl)
      dirtyRef.current = false
    } else {
      wipeCanvas()
      setHasContent(false)
      dirtyRef.current = false
    }
  }, [initialDataUrl, drawInitial, wipeCanvas])

  // Map a pointer event (in CSS pixels) to canvas-internal coords. The canvas
  // is rendered at fluid CSS width but its drawing buffer is fixed at W×H, so
  // we scale by the rendered-to-buffer ratio.
  const pointFromEvent = (e: PointerEvent | React.PointerEvent): { x: number; y: number } | null => {
    const c = canvasRef.current
    if (!c) return null
    const rect = c.getBoundingClientRect()
    const scaleX = c.width / rect.width
    const scaleY = c.height / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const ctx = getCtx()
    const pt = pointFromEvent(e)
    if (!ctx || !pt) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    drawingRef.current = true
    lastPointRef.current = pt
    // Draw a 1px dot so a single tap leaves a mark
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, STROKE_WIDTH / 2, 0, Math.PI * 2)
    ctx.fillStyle = STROKE_COLOR
    ctx.fill()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    e.preventDefault()
    const ctx = getCtx()
    const pt = pointFromEvent(e)
    const last = lastPointRef.current
    if (!ctx || !pt || !last) return
    const midX = (last.x + pt.x) / 2
    const midY = (last.y + pt.y) / 2
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.quadraticCurveTo(midX, midY, pt.x, pt.y)
    ctx.stroke()
    lastPointRef.current = pt
  }

  const finishStroke = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    drawingRef.current = false
    lastPointRef.current = null
    dirtyRef.current = true
    setHasContent(true)
    if (e) {
      try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch {}
    }
    if (onChange) {
      const url = canvasRef.current?.toDataURL('image/png')
      if (url) onChange(url)
    }
  }

  useImperativeHandle(ref, () => ({
    toDataUrl() {
      if (!hasContent) return null
      return canvasRef.current?.toDataURL('image/png') ?? null
    },
    clear() {
      wipeCanvas()
      dirtyRef.current = false
      setHasContent(false)
      onChange?.('')
    },
    isDirty() {
      return dirtyRef.current
    },
  }), [hasContent, onChange, wipeCanvas])

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      className={`bg-white border border-gray-300 rounded touch-none w-full max-w-[600px] block ${className}`}
      style={{ aspectRatio: `${W} / ${H}` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
      onPointerLeave={finishStroke}
    />
  )
})

export default SignaturePad
