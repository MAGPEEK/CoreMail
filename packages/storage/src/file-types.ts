/**
 * File type helpers shared by the inbound attachment filter (security-filter,
 * SecuritySettings.attachmentBlockedExt) and the webmail attachment policy
 * (webmail-policy.ts). Pure — no I/O.
 *
 * Block-list semantics (both): extensions without dot, case-insensitive; the
 * extension of a file name ignores trailing dots and spaces (Windows runs
 * "a.exe. " as .exe).
 *
 * The webmail policy also looks at the declared MIME type and at the content
 * (magic bytes): a file is matched by every extension it may really be. For
 * container formats (ZIP, OLE, …) a file name that fits the detected format
 * keeps its own extension ("report.docx" with ZIP bytes is a .docx), a name
 * that does not fit gets every extension of the format ("photo.jpg" with ZIP
 * bytes may be a .jar).
 */

/** 'EXE' / '.exe' / ' exe ' → 'exe'; '' for garbage. */
export function normalizeExtension(ext: string): string {
  return ext.trim().toLowerCase().replace(/^\.+/, '');
}

/** A cleaned, de-duplicated extension list (empty entries and entries with separators dropped). */
export function normalizeExtensionList(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const ext = normalizeExtension(raw);
    if (/^[a-z0-9][a-z0-9_+-]{0,19}$/.test(ext)) out.add(ext);
  }
  return [...out];
}

/**
 * Extension of a filename after stripping trailing dots/spaces (Windows ignores them: "a.exe. " runs as .exe).
 * Compatibility forms are folded (NFKC: full-width "ｅｘｅ" → "exe") and invisible format / control characters
 * (bidi overrides, zero-width spaces, NUL) are dropped first, so "a.ex​e" or "a.exe‬" cannot hide an
 * extension that a client or a save dialog may restore.
 */
export function fileExtension(filename: string): string {
  const name = filename.normalize('NFKC').replace(/[\p{Cf}\p{Cc}]/gu, '').replace(/[\s.]+$/, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A detected content format and the extensions a file of that format may carry. */
export interface SniffedType {
  format: string;
  extensions: readonly string[];
}

const ASCII = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

interface Signature { format: string; offset: number; bytes: number[]; extensions: readonly string[] }

const WINDOWS_EXECUTABLE = ['exe', 'dll', 'scr', 'com', 'cpl', 'ocx', 'sys', 'drv', 'efi', 'pif'];
const ZIP_FAMILY = ['zip', 'jar', 'apk', 'appx', 'msix', 'xpi', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm',
  'odt', 'ods', 'odp', 'epub', 'vsix', 'nupkg', 'kmz'];
const OLE_FAMILY = ['msi', 'msp', 'doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'msg', 'vsd', 'pub', 'mpp'];

const SIGNATURES: readonly Signature[] = [
  { format: 'windows-executable', offset: 0, bytes: ASCII('MZ'), extensions: WINDOWS_EXECUTABLE },
  { format: 'elf', offset: 0, bytes: [0x7f, ...ASCII('ELF')], extensions: ['elf', 'so', 'bin', 'run', 'out'] },
  { format: 'mach-o', offset: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe], extensions: ['macho', 'dylib', 'bundle', 'app'] },
  { format: 'mach-o', offset: 0, bytes: [0xce, 0xfa, 0xed, 0xfe], extensions: ['macho', 'dylib', 'bundle', 'app'] },
  { format: 'mach-o', offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xcf], extensions: ['macho', 'dylib', 'bundle', 'app'] },
  { format: 'mach-o', offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xce], extensions: ['macho', 'dylib', 'bundle', 'app'] },
  { format: 'java-class', offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], extensions: ['class', 'macho', 'dylib'] },
  { format: 'script', offset: 0, bytes: ASCII('#!'), extensions: ['sh', 'bash', 'zsh', 'py', 'pl', 'rb', 'command'] },
  { format: 'zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], extensions: ZIP_FAMILY },
  { format: 'zip', offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], extensions: ZIP_FAMILY },
  { format: 'ole', offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], extensions: OLE_FAMILY },
  { format: 'windows-shortcut', offset: 0, bytes: [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], extensions: ['lnk'] },
  { format: 'cab', offset: 0, bytes: ASCII('MSCF'), extensions: ['cab'] },
  { format: 'rar', offset: 0, bytes: [...ASCII('Rar!'), 0x1a, 0x07], extensions: ['rar'] },
  { format: '7z', offset: 0, bytes: [...ASCII('7z'), 0xbc, 0xaf, 0x27, 0x1c], extensions: ['7z'] },
  { format: 'gzip', offset: 0, bytes: [0x1f, 0x8b], extensions: ['gz', 'tgz'] },
  { format: 'pdf', offset: 0, bytes: ASCII('%PDF-'), extensions: ['pdf'] },
  { format: 'png', offset: 0, bytes: [0x89, ...ASCII('PNG'), 0x0d, 0x0a, 0x1a, 0x0a], extensions: ['png'] },
  { format: 'jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff], extensions: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  { format: 'gif', offset: 0, bytes: ASCII('GIF8'), extensions: ['gif'] },
  { format: 'iso', offset: 0x8001, bytes: ASCII('CD001'), extensions: ['iso', 'img'] },
];

const HTML_EXTENSIONS = ['html', 'htm', 'xhtml', 'hta', 'shtml', 'mht', 'mhtml'];
const SVG_EXTENSIONS = ['svg', 'svgz'];

/** Bytes needed by sniffFileType (the ISO signature sits at 0x8001). */
export const SNIFF_BYTES = 0x8001 + 5;

function startsWith(head: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

/** Leading text of the content, lower-cased, without BOM and leading whitespace (markup detection). */
function leadingText(head: Uint8Array): string {
  const text = Buffer.from(head.subarray(0, 1024)).toString('latin1').replace(/^ï»¿/, '');
  return text.trimStart().toLowerCase();
}

/** The content format of `head` (the first bytes of a file), or null when unknown. */
export function sniffFileType(head: Uint8Array): SniffedType | null {
  for (const s of SIGNATURES) {
    if (startsWith(head, s.offset, s.bytes)) return { format: s.format, extensions: s.extensions };
  }
  const text = leadingText(head);
  if (/^<svg[\s>]/.test(text) || (text.startsWith('<?xml') && /<svg[\s>]/.test(text))) {
    return { format: 'svg', extensions: SVG_EXTENSIONS };
  }
  if (/^<(!doctype html|html|head|body|script|iframe|hta:application)[\s>]/.test(text)) {
    return { format: 'html', extensions: HTML_EXTENSIONS };
  }
  return null;
}

/** Extensions a declared media type stands for (types that matter for a block list). */
const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/x-msdownload': WINDOWS_EXECUTABLE,
  'application/x-dosexec': WINDOWS_EXECUTABLE,
  'application/x-msdos-program': WINDOWS_EXECUTABLE,
  'application/x-executable': ['elf', 'bin', 'run'],
  'application/vnd.microsoft.portable-executable': WINDOWS_EXECUTABLE,
  'application/x-ms-installer': ['msi'],
  'application/x-msi': ['msi'],
  'application/x-ole-storage': OLE_FAMILY,
  'application/x-bat': ['bat', 'cmd'],
  'application/x-msbatch': ['bat', 'cmd'],
  'application/x-sh': ['sh'],
  'application/x-shellscript': ['sh'],
  'application/vbs': ['vbs', 'vbe'],
  'application/x-vbs': ['vbs', 'vbe'],
  'text/vbscript': ['vbs', 'vbe'],
  'application/javascript': ['js', 'mjs', 'jse'],
  'application/x-javascript': ['js', 'mjs', 'jse'],
  'text/javascript': ['js', 'mjs', 'jse'],
  'application/hta': ['hta'],
  'application/x-ms-shortcut': ['lnk'],
  'application/java-archive': ['jar'],
  'application/x-java-archive': ['jar'],
  'application/vnd.android.package-archive': ['apk'],
  'application/x-iso9660-image': ['iso'],
  'application/zip': ['zip'],
  'application/x-zip-compressed': ['zip'],
  'application/x-rar-compressed': ['rar'],
  'application/vnd.rar': ['rar'],
  'application/x-7z-compressed': ['7z'],
  'application/pdf': ['pdf'],
  'text/html': HTML_EXTENSIONS,
  'application/xhtml+xml': HTML_EXTENSIONS,
  'image/svg+xml': SVG_EXTENSIONS,
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/gif': ['gif'],
  'application/msword': ['doc', 'dot'],
  'application/vnd.ms-excel': ['xls', 'xlt'],
  'application/vnd.ms-powerpoint': ['ppt', 'pps'],
};

/** Extensions of a declared media type ("Type/Sub; charset=…" accepted); empty when unknown. */
export function mimeTypeExtensions(mimeType: string | null | undefined): readonly string[] {
  const t = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  return MIME_EXTENSIONS[t] ?? [];
}

/**
 * Every extension a file may really be: its own name, plus the extensions of
 * the declared type and of the detected content when the name does not fit
 * them (pure; `head` may be empty when the content is not available).
 */
export function candidateExtensions(file: { filename: string; mimeType?: string | null | undefined; head?: Uint8Array | undefined }): Set<string> {
  const own = fileExtension(file.filename);
  const out = new Set<string>(own ? [own] : []);
  const addUnlessFitting = (family: readonly string[]) => {
    if (own && family.includes(own)) return;
    for (const e of family) out.add(e);
  };
  addUnlessFitting(mimeTypeExtensions(file.mimeType));
  const sniffed = file.head && file.head.length > 0 ? sniffFileType(file.head) : null;
  if (sniffed) addUnlessFitting(sniffed.extensions);
  return out;
}

/** The first extension of `candidates` that is in `list`, or null. */
export function matchExtensionList(candidates: ReadonlySet<string>, list: readonly string[]): string | null {
  for (const ext of list) if (candidates.has(normalizeExtension(ext))) return normalizeExtension(ext);
  return null;
}
