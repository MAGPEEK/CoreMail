/**
 * 9.5: geometry of the profile photo crop dialog (components/settings/PhotoCropDialog.tsx)
 * — pure, unit-tested.
 *
 * The stage shows the image behind a circular mask; the circle's bounding
 * square (`cropSize` screen px) is what gets uploaded. Positions are in screen
 * px relative to that square's top-left corner:
 *
 *   scale  = coverScale × zoom     image px → screen px; zoom 1 = the image's
 *                                  shorter side exactly fills the square
 *   x, y   = top-left corner of the scaled image (always ≤ 0)
 *
 * clampCrop keeps the image covering the whole square at every step (no empty
 * corner can ever be uploaded); cropRect turns the state into the source
 * rectangle the canvas renders into OUTPUT_SIZE × OUTPUT_SIZE.
 */

/** Edge length of the uploaded rendering (px). */
export const OUTPUT_SIZE = 512;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Keyboard steps: arrow keys move by PAN_STEP px (Shift: PAN_STEP_LARGE), +/- zoom by ZOOM_STEP. */
export const PAN_STEP = 10;
export const PAN_STEP_LARGE = 50;
export const ZOOM_STEP = 1.1;

export interface CropGeometry {
  /** Natural size of the image. */
  imageWidth: number;
  imageHeight: number;
  /** Edge of the crop square on screen (px). */
  cropSize: number;
}

export interface CropState { zoom: number; x: number; y: number }

export interface Point { x: number; y: number }

/** Scale at zoom 1: the shorter side covers the crop square. */
export function coverScale(g: CropGeometry): number {
  return g.cropSize / Math.min(g.imageWidth, g.imageHeight);
}

export function scaleOf(g: CropGeometry, zoom: number): number {
  return coverScale(g) * zoom;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Zoom within [MIN_ZOOM, MAX_ZOOM], image edges never inside the crop square. */
export function clampCrop(g: CropGeometry, s: CropState): CropState {
  const zoom = clamp(Number.isFinite(s.zoom) ? s.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const scale = scaleOf(g, zoom);
  const minX = g.cropSize - g.imageWidth * scale;
  const minY = g.cropSize - g.imageHeight * scale;
  return { zoom, x: clamp(s.x, minX, 0), y: clamp(s.y, minY, 0) };
}

/** Zoom 1, image centred. */
export function initialCrop(g: CropGeometry): CropState {
  const scale = scaleOf(g, MIN_ZOOM);
  return clampCrop(g, {
    zoom: MIN_ZOOM,
    x: (g.cropSize - g.imageWidth * scale) / 2,
    y: (g.cropSize - g.imageHeight * scale) / 2,
  });
}

export function panBy(g: CropGeometry, s: CropState, dx: number, dy: number): CropState {
  return clampCrop(g, { ...s, x: s.x + dx, y: s.y + dy });
}

/**
 * New zoom, keeping the image point under `anchor` (crop-square coordinates;
 * default: the centre) where it is.
 */
export function zoomTo(g: CropGeometry, s: CropState, zoom: number, anchor?: Point): CropState {
  const target = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const p = anchor ?? { x: g.cropSize / 2, y: g.cropSize / 2 };
  const ratio = scaleOf(g, target) / scaleOf(g, s.zoom);
  return clampCrop(g, { zoom: target, x: p.x - (p.x - s.x) * ratio, y: p.y - (p.y - s.y) * ratio });
}

/** Zoom factor of one wheel event (deltaY > 0 = away from the user = zoom out). */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -200, 200) * 0.002);
}

export type CropKeyAction = { pan: Point } | { zoomFactor: number };

/** Keyboard control of the stage: arrows move the image, + / - zoom; null for other keys. */
export function cropKeyAction(key: string, shift: boolean): CropKeyAction | null {
  const step = shift ? PAN_STEP_LARGE : PAN_STEP;
  switch (key) {
    // the arrow moves the image the way the key points
    case 'ArrowLeft': return { pan: { x: -step, y: 0 } };
    case 'ArrowRight': return { pan: { x: step, y: 0 } };
    case 'ArrowUp': return { pan: { x: 0, y: -step } };
    case 'ArrowDown': return { pan: { x: 0, y: step } };
    case '+': case '=': return { zoomFactor: ZOOM_STEP };
    case '-': case '_': return { zoomFactor: 1 / ZOOM_STEP };
    default: return null;
  }
}

/** Source rectangle (image px) of the crop square, inside the image. */
export interface SourceRect { sx: number; sy: number; size: number }

export function cropRect(g: CropGeometry, s: CropState): SourceRect {
  const c = clampCrop(g, s);
  const scale = scaleOf(g, c.zoom);
  const size = Math.min(g.cropSize / scale, g.imageWidth, g.imageHeight);
  return {
    sx: clamp(-c.x / scale, 0, g.imageWidth - size),
    sy: clamp(-c.y / scale, 0, g.imageHeight - size),
    size,
  };
}

/** Position of the whole image inside a round preview of `previewSize` px showing the crop. */
export function previewBox(g: CropGeometry, s: CropState, previewSize: number): { left: number; top: number; width: number; height: number } {
  const r = cropRect(g, s);
  const k = previewSize / r.size;
  return { left: -r.sx * k, top: -r.sy * k, width: g.imageWidth * k, height: g.imageHeight * k };
}

// ── File checks (before the dialog opens) ─────────────────────────────────────

/** Types the file picker accepts (the browser decodes them; the upload is always the rendered PNG). */
export const PHOTO_FILE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTO_FILE_BYTES = 5 * 1024 * 1024;

/** German error text for a picked file, or null when it may be opened in the crop dialog. */
export function photoFileError(file: { type: string; size: number }): string | null {
  if (!PHOTO_FILE_TYPES.includes(file.type.toLowerCase())) return 'Bitte ein Bild im Format JPEG, PNG oder WebP wählen.';
  if (file.size > MAX_PHOTO_FILE_BYTES) return 'Das Bild ist größer als 5 MB.';
  if (file.size === 0) return 'Die Datei ist leer.';
  return null;
}
