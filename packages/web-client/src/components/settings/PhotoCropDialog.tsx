/**
 * 9.5: crop dialog of the profile photo. The picked image lies behind a round
 * mask on a square stage; it can be moved (mouse / touch drag, arrow keys) and
 * zoomed (slider, mouse wheel, + / -), and always covers the circle
 * (lib/avatarCrop.ts). Live previews in the three sizes the webmail uses.
 * "Übernehmen" renders the circle's square into a 512×512 PNG (the circle is
 * only the display mask) and hands it to the caller, which uploads it.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '../Modal.js';
import {
  OUTPUT_SIZE, MIN_ZOOM, MAX_ZOOM, cropKeyAction, cropRect, initialCrop, panBy, previewBox, scaleOf,
  wheelZoomFactor, zoomTo, type CropGeometry, type CropState,
} from '../../lib/avatarCrop.js';

/** Stage edge and the crop circle's margin inside it (px); fits a 375 px wide screen. */
const STAGE = 272;
const MARGIN = 16;
const CROP = STAGE - 2 * MARGIN;
const PREVIEW_SIZES = [96, 40, 28] as const;

interface Props {
  /** blob: URL of the picked file */
  src: string;
  busy: boolean;
  onCancel: () => void;
  onApply: (png: Blob) => void;
}

/** Renders the crop into an OUTPUT_SIZE² PNG. */
function renderCrop(img: HTMLImageElement, g: CropGeometry, s: CropState): Promise<Blob> {
  const r = cropRect(g, s);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas nicht verfügbar'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.sx, r.sy, r.size, r.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), 'image/png');
  });
}

function CropPreview({ src, g, s, size }: { src: string; g: CropGeometry; s: CropState; size: number }) {
  const box = previewBox(g, s, size);
  return (
    <div className="relative rounded-full overflow-hidden bg-surface-2 shrink-0" style={{ width: size, height: size }}>
      <img src={src} alt="" draggable={false} className="absolute max-w-none" style={box} />
    </div>
  );
}

export function PhotoCropDialog({ src, busy, onCancel, onApply }: Props) {
  const titleId = useId();
  const zoomId = useId();
  const hintId = useId();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [state, setState] = useState<CropState>({ zoom: 1, x: 0, y: 0 });
  const [failed, setFailed] = useState(false);

  const g = useMemo<CropGeometry | null>(() => (size ? { imageWidth: size.w, imageHeight: size.h, cropSize: CROP } : null), [size]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !g) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left - MARGIN, y: e.clientY - rect.top - MARGIN };
      setState((s) => zoomTo(g, s, s.zoom * wheelZoomFactor(e.deltaY), anchor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [g]);

  const onLoad = () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) { setFailed(true); return; }
    const next = { w: img.naturalWidth, h: img.naturalHeight };
    setSize(next);
    setState(initialCrop({ imageWidth: next.w, imageHeight: next.h, cropSize: CROP }));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!g || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!g || !d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
    setState((s) => panBy(g, s, dx, dy));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!g) return;
    const action = cropKeyAction(e.key, e.shiftKey);
    if (!action) return;
    e.preventDefault();
    setState((s) => ('pan' in action ? panBy(g, s, action.pan.x, action.pan.y) : zoomTo(g, s, s.zoom * action.zoomFactor)));
  };

  const apply = () => {
    if (!g || !imgRef.current) return;
    renderCrop(imgRef.current, g, state).then(onApply, () => setFailed(true));
  };

  const scale = g ? scaleOf(g, state.zoom) : 1;

  return (
    <Modal onClose={busy ? () => undefined : onCancel} labelledBy={titleId} closeOnBackdrop={false}
      className="bg-surface rounded-lg shadow-2xl w-full max-w-md max-h-full overflow-y-auto">
      <div className="p-5 space-y-4">
        <h2 id={titleId} className="text-lg font-semibold text-fg">Foto zuschneiden</h2>
        <p id={hintId} className="text-sm text-fg-subtle">
          Ziehen Sie das Bild an die gewünschte Stelle und vergrößern Sie es mit dem Regler oder dem Mausrad.
          Tastatur: Pfeiltasten verschieben, Plus und Minus zoomen.
        </p>

        <div
          ref={stageRef}
          tabIndex={0}
          role="application"
          aria-label="Bildausschnitt"
          aria-describedby={hintId}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className="relative mx-auto overflow-hidden rounded bg-surface-2 touch-none select-none cursor-move"
          style={{ width: STAGE, height: STAGE }}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={onLoad}
            onError={() => setFailed(true)}
            className="absolute max-w-none pointer-events-none"
            style={g ? { left: MARGIN + state.x, top: MARGIN + state.y, width: g.imageWidth * scale, height: g.imageHeight * scale } : { visibility: 'hidden' }}
          />
          {/* Round mask: dims everything outside the circle that is uploaded */}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-scrim/60 pointer-events-none"
            style={{ maskImage: `radial-gradient(circle at center, transparent ${CROP / 2}px, black ${CROP / 2 + 0.5}px)`, WebkitMaskImage: `radial-gradient(circle at center, transparent ${CROP / 2}px, black ${CROP / 2 + 0.5}px)` }}
          />
          <div aria-hidden="true" className="absolute rounded-full border-2 border-white/80 pointer-events-none"
            style={{ left: MARGIN, top: MARGIN, width: CROP, height: CROP }} />
        </div>

        {failed && <p role="alert" className="text-sm text-danger-fg">Das Bild kann nicht geöffnet werden. Bitte eine andere Datei wählen.</p>}

        <div className="flex items-center gap-3">
          <label htmlFor={zoomId} className="text-sm font-medium text-fg-muted">Zoom</label>
          <input
            id={zoomId}
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={state.zoom}
            disabled={!g || busy}
            aria-valuetext={`${Math.round(state.zoom * 100)} %`}
            onChange={(e) => { if (g) setState((s) => zoomTo(g, s, Number(e.target.value))); }}
            className="flex-1 accent-accent"
          />
        </div>

        {g && (
          <div>
            <p className="text-sm font-medium text-fg-muted mb-2">Vorschau</p>
            <div className="flex items-end gap-4">
              {PREVIEW_SIZES.map((px) => <CropPreview key={px} src={src} g={g} s={state} size={px} />)}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Abbrechen</button>
          <button type="button" className="btn-primary" onClick={apply} disabled={!g || busy || failed}>
            {busy ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Speichern…</> : 'Übernehmen'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
