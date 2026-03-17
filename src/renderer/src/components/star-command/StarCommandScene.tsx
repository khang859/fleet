import { useRef, useEffect } from 'react'

export function StarCommandScene({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const lastFrameRef = useRef<number>(0)
  const pendingResizeRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    // Sync canvas size to container
    const applyResize = () => {
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
      pendingResizeRef.current = false
    }
    applyResize()

    const ro = new ResizeObserver(() => {
      // Debounce: apply resize on next RAF tick
      pendingResizeRef.current = true
    })
    ro.observe(container)

    let stopped = false

    function frame(now: number) {
      if (stopped) return

      // Apply pending resize
      if (pendingResizeRef.current) applyResize()

      const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16 // used in subsequent tasks
      void deltaMs
      lastFrameRef.current = now

      const w = canvas!.width
      const h = canvas!.height

      // Background
      ctx!.fillStyle = '#0a0a1a'
      ctx!.fillRect(0, 0, w, h)

      // TODO: layers will be added in subsequent tasks

      rafRef.current = requestAnimationFrame(frame)
    }

    const handleVisibility = () => {
      if (document.hidden) {
        stopped = true
        cancelAnimationFrame(rafRef.current)
      } else {
        stopped = false
        lastFrameRef.current = 0 // reset to avoid deltaMs spike
        rafRef.current = requestAnimationFrame(frame)
      }
    }
    const handleBlur = () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
    }
    const handleFocus = () => {
      if (!stopped) return
      stopped = false
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(frame)
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)

    rafRef.current = requestAnimationFrame(frame)

    return () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  )
}
