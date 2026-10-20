import { X } from 'lucide-react'
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/lib/i18n'
import { useAppShellOverlay, useFocusTrap } from '../ui'

interface TranscriptImageProps {
  source: string
  alt: string
}

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const DRAG_DEADZONE_PX = 4

export function TranscriptImage({ source, alt }: TranscriptImageProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [transform, setTransform] = useState({ zoom: 1, panX: 0, panY: 0 })
  const [panning, setPanning] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startPanX: number; startPanY: number; active: boolean } | null>(null)
  const titleId = useId()
  const lightboxRef = useFocusTrap<HTMLElement>(open, () => setOpen(false))
  useAppShellOverlay(open)

  useEffect(() => {
    if (!open) {
      setTransform({ zoom: 1, panX: 0, panY: 0 })
      setPanning(false)
      dragRef.current = null
    }
  }, [open])

  const applyAnchoredZoom = (nextZoomRaw: number, clientX: number, clientY: number) => {
    const img = imageRef.current
    setTransform((current) => {
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoomRaw))
      if (nextZoom <= 1.01) return { zoom: 1, panX: 0, panY: 0 }
      if (!img) return { ...current, zoom: nextZoom }
      const rect = img.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const offsetX = clientX - centerX
      const offsetY = clientY - centerY
      const ratio = nextZoom / current.zoom
      return {
        zoom: nextZoom,
        panX: current.panX - offsetX * (ratio - 1),
        panY: current.panY - offsetY * (ratio - 1),
      }
    })
  }

  const imageStyle = {
    '--zoom': String(transform.zoom),
    '--pan-x': `${Math.round(transform.panX)}px`,
    '--pan-y': `${Math.round(transform.panY)}px`,
  } as CSSProperties

  return (
    <>
      <button type="button" className="image-part__preview" aria-label={t('transcript.image.expand')} onClick={() => setOpen(true)}>
        <img className="image-part" src={source} alt={alt} />
      </button>
      {open
        ? createPortal(
            <div
              className="image-lightbox"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false)
              }}
              onWheel={(event) => {
                event.preventDefault()
                const factor = Math.exp(-event.deltaY * 0.0022)
                applyAnchoredZoom(transform.zoom * factor, event.clientX, event.clientY)
              }}
            >
              <section
                ref={lightboxRef}
                className="image-lightbox__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setOpen(false)
                }}
              >
                <h2 id={titleId} className="sr-only">
                  {t('transcript.image.expanded')}
                </h2>
                {transform.zoom > 1.01 ? (
                  <button
                    type="button"
                    className="image-lightbox__zoom-badge"
                    onClick={() => setTransform({ zoom: 1, panX: 0, panY: 0 })}
                    title="Reset zoom"
                  >
                    {Math.round(transform.zoom * 100)}%
                  </button>
                ) : null}
                <button type="button" className="image-lightbox__close" aria-label={t('transcript.image.close')} onClick={() => setOpen(false)}>
                  <X size={18} />
                </button>
                <img
                  ref={imageRef}
                  className={`image-lightbox__image ${transform.zoom > 1.01 ? 'is-zoomed' : ''} ${panning ? 'is-panning' : ''}`}
                  style={imageStyle}
                  src={source}
                  alt={alt}
                  draggable={false}
                  onDoubleClick={(event) => {
                    const targetZoom = transform.zoom > 1.05 ? 1 : 2
                    applyAnchoredZoom(targetZoom, event.clientX, event.clientY)
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || transform.zoom <= 1.01) return
                    event.currentTarget.setPointerCapture?.(event.pointerId)
                    dragRef.current = {
                      pointerId: event.pointerId,
                      startX: event.clientX,
                      startY: event.clientY,
                      startPanX: transform.panX,
                      startPanY: transform.panY,
                      active: false,
                    }
                  }}
                  onPointerMove={(event) => {
                    const drag = dragRef.current
                    if (!drag || drag.pointerId !== event.pointerId) return
                    const dx = event.clientX - drag.startX
                    const dy = event.clientY - drag.startY
                    if (!drag.active && Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return
                    if (!drag.active) {
                      drag.active = true
                      setPanning(true)
                    }
                    setTransform((current) => ({
                      ...current,
                      panX: drag.startPanX + dx,
                      panY: drag.startPanY + dy,
                    }))
                  }}
                  onPointerUp={(event) => {
                    if (dragRef.current?.pointerId === event.pointerId) {
                      dragRef.current = null
                      setPanning(false)
                    }
                  }}
                  onPointerCancel={(event) => {
                    if (dragRef.current?.pointerId === event.pointerId) {
                      dragRef.current = null
                      setPanning(false)
                    }
                  }}
                />
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
