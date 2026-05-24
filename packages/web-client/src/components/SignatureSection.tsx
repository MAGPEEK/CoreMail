import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bold, Italic, Underline as LucideUnderline, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Link2, Undo2, Redo2, Eraser,
  ChevronDown, Quote, Highlighter, Type, Image as ImageIcon,
  Loader2, Eye, Code2,
} from 'lucide-react';
import { useEditor, EditorContent, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import UnderlineExt from '@tiptap/extension-underline';
import LinkExt from '@tiptap/extension-link';
import TextAlignExt from '@tiptap/extension-text-align';
import { Color } from '@tiptap/extension-color';
import TextStyle from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import FontFamilyExt from '@tiptap/extension-font-family';
import ImageExt from '@tiptap/extension-image';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

interface SigData {
  signature: string;
  autoNew:   boolean;
  autoReply: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Font-Size Extension (TipTap hat keine Standard-Extension dafür)
// ─────────────────────────────────────────────────────────────────────────────

// Custom Extension für inline `style="font-size: …"` Attribut.
// Wir definieren KEIN globales Modul-Augment für Commands<> (vermeidet ChainedCommands-
// Konflikte); stattdessen rufen wir das Mark direkt via setMark/unsetMark auf.
const FontSizeExt = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] as string[] };
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.fontSize || null,
          renderHTML: (attrs: Record<string, unknown>) => attrs['fontSize']
            ? { style: `font-size: ${attrs['fontSize']}` }
            : {},
        },
      },
    }];
  },
});

/** Helper: setzt oder entfernt font-size am aktuellen TextStyle-Mark. */
function applyFontSize(editor: ReturnType<typeof useEditor>, size: string): void {
  if (!editor) return;
  if (!size) {
    editor.chain().focus().setMark('textStyle', { fontSize: null }).run();
  } else {
    editor.chain().focus().setMark('textStyle', { fontSize: size }).run();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#ffffff',
  '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff',
  '#9900ff', '#ff00ff', '#e06666', '#f6b26b', '#ffd966', '#93c47d',
  '#76d7ea', '#6fa8dc', '#8e7cc3', '#c27ba0', '#cc0000', '#e69138',
];

const HIGHLIGHT_COLORS = [
  '#ffff00', '#00ff00', '#00ffff', '#ff99cc', '#ff9900', '#cc99ff',
  '#fce5cd', '#fff2cc', '#d9ead3', '#cfe2f3', '#ead1dc', '#f4cccc',
];

const FONT_FAMILIES = [
  { label: 'Standard',        value: '' },
  { label: 'Arial',           value: 'Arial, sans-serif' },
  { label: 'Calibri',         value: 'Calibri, sans-serif' },
  { label: 'Georgia',         value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Courier New',     value: '"Courier New", monospace' },
  { label: 'Verdana',         value: 'Verdana, sans-serif' },
  { label: 'Tahoma',          value: 'Tahoma, sans-serif' },
  { label: 'Trebuchet MS',    value: '"Trebuchet MS", sans-serif' },
  { label: 'Comic Sans MS',   value: '"Comic Sans MS", cursive' },
];

const FONT_SIZES = [
  { label: 'Klein',     value: '12px' },
  { label: 'Normal',    value: '14px' },
  { label: 'Mittel',    value: '16px' },
  { label: 'Groß',      value: '20px' },
  { label: 'Sehr groß', value: '28px' },
];

const MAX_IMAGE_BYTES = 500 * 1024; // 500 KB als data:URL — sonst werden Mails zu groß

// ─────────────────────────────────────────────────────────────────────────────
// UI-Helpers
// ─────────────────────────────────────────────────────────────────────────────

function Sep() {
  return <div className="w-px h-5 bg-gray-200 mx-0.5 shrink-0" />;
}

function ToolBtn({
  onClick, active = false, disabled = false, title, children,
}: {
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(e); }}
      title={title}
      disabled={disabled}
      className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
        active
          ? 'bg-blue-100 text-blue-700'
          : 'hover:bg-gray-200 text-gray-700'
      } disabled:opacity-30 disabled:cursor-default`}
    >
      {children}
    </button>
  );
}

function ColorPickerPopover({
  colors, onSelect, onClose, currentColor, title,
}: {
  colors: string[];
  onSelect: (c: string) => void;
  onClose: () => void;
  currentColor?: string;
  title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-2.5 z-50 min-w-[180px]">
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{title}</p>
      <div className="grid grid-cols-6 gap-1">
        {colors.map((c) => (
          <button
            type="button"
            key={c}
            onMouseDown={(e) => { e.preventDefault(); onSelect(c); onClose(); }}
            style={{
              backgroundColor: c,
              border: c === currentColor ? '2px solid #1a73e8' : '1px solid #e0e0e0',
            }}
            className="w-5 h-5 rounded cursor-pointer hover:scale-110 transition-transform"
            title={c}
          />
        ))}
      </div>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); onSelect(''); onClose(); }}
        className="mt-2 pt-2 border-t border-gray-100 w-full text-xs text-gray-500 hover:text-gray-800 text-center"
      >
        Farbe entfernen
      </button>
    </div>
  );
}

function FontDropdown({
  label, options, current, onSelect, width = 100,
}: {
  label: string;
  options: { label: string; value: string }[];
  current: string | undefined;
  onSelect: (v: string) => void;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const activeLabel = options.find((o) => o.value === current)?.label ?? label;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className="flex items-center gap-1 px-2 h-7 text-xs rounded hover:bg-gray-200 border border-transparent"
        style={{ minWidth: width }}
      >
        <span className="flex-1 text-left text-gray-700 truncate" style={current ? { fontFamily: current.includes(',') ? current : undefined, fontSize: current.endsWith('px') ? current : undefined } : undefined}>
          {activeLabel}
        </span>
        <ChevronDown size={11} className="shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-50" style={{ minWidth: width + 20 }}>
          {options.map(({ label: l, value }) => (
            <button
              type="button"
              key={l}
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); onSelect(value); }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-gray-50 text-sm ${
                current === value ? 'text-blue-600' : 'text-gray-700'
              }`}
              style={value ? { fontFamily: value.includes(',') ? value : undefined, fontSize: value.endsWith('px') ? value : undefined } : undefined}
            >
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hauptkomponente
// ─────────────────────────────────────────────────────────────────────────────

export function SignatureSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['user-signature'],
    queryFn: () => api.get<SigData>('/user/signature'),
  });

  const [autoNew,   setAutoNew]   = useState(true);
  const [autoReply, setAutoReply] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showTextColor, setShowTextColor] = useState(false);
  const [showHighlight, setShowHighlight] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentInitialized = useRef(false);

  useEffect(() => {
    if (data) { setAutoNew(data.autoNew); setAutoReply(data.autoReply); }
  }, [data]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      UnderlineExt,
      LinkExt.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-blue-600 underline cursor-pointer' },
      }),
      TextAlignExt.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      FontFamilyExt,
      FontSizeExt,
      ImageExt.configure({
        inline: true,
        allowBase64: true,
        HTMLAttributes: { class: 'inline-block max-w-full h-auto' },
      }),
    ],
    content: '',
    editorProps: {
      attributes: { class: 'outline-none min-h-[200px] text-sm text-gray-800 prose prose-sm max-w-none' },
    },
  });

  // Initial content nur einmal setzen (verhindert Cursor-Reset)
  useEffect(() => {
    if (editor && data?.signature && !contentInitialized.current) {
      editor.commands.setContent(data.signature);
      contentInitialized.current = true;
    }
  }, [editor, data?.signature]);

  // ── Aktionen ──────────────────────────────────────────────────────────────
  const insertLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link-URL eingeben:', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      // Wenn Text markiert ist → Link auf markierten Text
      // Wenn nichts markiert ist → Link mit URL als Text einfügen
      const { from, to } = editor.state.selection;
      if (from === to) {
        editor.chain().focus().insertContent(`<a href="${url.trim()}">${url.trim()}</a>`).run();
      } else {
        editor.chain().focus().setLink({ href: url.trim() }).run();
      }
    }
  }, [editor]);

  const insertImageFromFile = useCallback((file: File) => {
    if (!editor) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Nur Bilddateien erlaubt');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(`Bild zu groß (max ${Math.round(MAX_IMAGE_BYTES / 1024)} KB) — Mails werden sonst sehr groß`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = String(ev.target?.result ?? '');
      if (src) editor.chain().focus().setImage({ src }).run();
    };
    reader.readAsDataURL(file);
  }, [editor]);

  const insertImageFromUrl = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('Bild-URL eingeben:', 'https://');
    if (!url || !url.trim()) return;
    editor.chain().focus().setImage({ src: url.trim() }).run();
  }, [editor]);

  // ── Drag & Drop ───────────────────────────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); }
  };
  const onDragLeave = (e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null;
    if (!rt || !(e.currentTarget as Node).contains(rt)) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) insertImageFromFile(file);
  };

  const mutation = useMutation({
    mutationFn: () => api.put('/user/signature', {
      signature: editor?.getHTML() ?? '',
      autoNew,
      autoReply,
    }),
    onSuccess: () => {
      toast.success('Signatur gespeichert');
      void qc.invalidateQueries({ queryKey: ['user-signature'] });
    },
    onError: () => toast.error('Fehler beim Speichern'),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12 text-gray-400">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (!editor) return null;

  const currentFont      = editor.getAttributes('textStyle').fontFamily as string | undefined;
  const currentFontSize  = editor.getAttributes('textStyle').fontSize as string | undefined;
  const currentTextColor = editor.getAttributes('textStyle').color as string | undefined;
  const currentHighlight = editor.getAttributes('highlight').color as string | undefined;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Signaturen</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Wird automatisch an deine E-Mails angehängt. Unterstützt Formatierung, Bilder, Links und Schriftarten.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowPreview((s) => !s)}
          className="btn-secondary text-xs shrink-0"
        >
          {showPreview ? <Code2 size={12} /> : <Eye size={12} />}
          {showPreview ? 'Editor' : 'Vorschau'}
        </button>
      </div>

      {/* Editor + Preview */}
      <div
        className="border border-gray-200 rounded-lg overflow-hidden bg-white relative"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 z-20 bg-blue-50/95 border-4 border-dashed border-blue-400 rounded-lg flex flex-col items-center justify-center pointer-events-none">
            <ImageIcon size={36} className="text-blue-500 mb-2" />
            <p className="text-blue-700 font-semibold text-sm">Bild hier ablegen</p>
          </div>
        )}

        {showPreview ? (
          /* Vorschau-Modus: Wie es im Mail-Reader aussieht */
          <div className="p-4 bg-gray-50">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Vorschau</p>
            <div
              className="bg-white border border-gray-200 rounded p-4 text-sm text-gray-800 prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: editor.getHTML() }}
            />
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-gray-200 bg-gray-50 flex-wrap">
              {/* Undo/Redo */}
              <ToolBtn title="Rückgängig" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
                <Undo2 size={13} />
              </ToolBtn>
              <ToolBtn title="Wiederholen" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
                <Redo2 size={13} />
              </ToolBtn>
              <Sep />

              {/* Schriftart */}
              <FontDropdown
                label="Schriftart"
                options={FONT_FAMILIES}
                current={currentFont}
                onSelect={(v) => {
                  if (!v) editor.chain().focus().unsetFontFamily().run();
                  else    editor.chain().focus().setFontFamily(v).run();
                }}
                width={120}
              />

              {/* Schriftgröße */}
              <FontDropdown
                label="Größe"
                options={FONT_SIZES}
                current={currentFontSize}
                onSelect={(v) => applyFontSize(editor, v)}
                width={80}
              />
              <Sep />

              {/* Fett/Kursiv/U/Strike */}
              <ToolBtn title="Fett" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
                <Bold size={13} />
              </ToolBtn>
              <ToolBtn title="Kursiv" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
                <Italic size={13} />
              </ToolBtn>
              <ToolBtn title="Unterstrichen" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
                <LucideUnderline size={13} />
              </ToolBtn>
              <ToolBtn title="Durchgestrichen" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
                <Strikethrough size={13} />
              </ToolBtn>
              <Sep />

              {/* Textfarbe */}
              <div className="relative">
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setShowTextColor((s) => !s); setShowHighlight(false); }}
                  title="Schriftfarbe"
                  className="w-8 h-7 flex flex-col items-center justify-center rounded hover:bg-gray-200 px-0.5"
                >
                  <Type size={11} className="text-gray-700" />
                  <div className="w-5 h-1 rounded-sm" style={{ backgroundColor: currentTextColor ?? '#000000' }} />
                </button>
                {showTextColor && (
                  <ColorPickerPopover
                    title="Schriftfarbe"
                    colors={TEXT_COLORS}
                    currentColor={currentTextColor}
                    onSelect={(c) => {
                      if (!c) editor.chain().focus().unsetColor().run();
                      else    editor.chain().focus().setColor(c).run();
                    }}
                    onClose={() => setShowTextColor(false)}
                  />
                )}
              </div>

              {/* Markierungsfarbe */}
              <div className="relative">
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setShowHighlight((s) => !s); setShowTextColor(false); }}
                  title="Markierungsfarbe"
                  className="w-8 h-7 flex flex-col items-center justify-center rounded hover:bg-gray-200 px-0.5"
                >
                  <Highlighter size={11} className="text-gray-700" />
                  <div className="w-5 h-1 rounded-sm" style={{ backgroundColor: currentHighlight ?? '#ffff00' }} />
                </button>
                {showHighlight && (
                  <ColorPickerPopover
                    title="Markierungsfarbe"
                    colors={HIGHLIGHT_COLORS}
                    currentColor={currentHighlight}
                    onSelect={(c) => {
                      if (!c) editor.chain().focus().unsetHighlight().run();
                      else    editor.chain().focus().toggleHighlight({ color: c }).run();
                    }}
                    onClose={() => setShowHighlight(false)}
                  />
                )}
              </div>
              <Sep />

              {/* Ausrichtung */}
              <ToolBtn title="Linksbündig" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>
                <AlignLeft size={13} />
              </ToolBtn>
              <ToolBtn title="Zentriert" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
                <AlignCenter size={13} />
              </ToolBtn>
              <ToolBtn title="Rechtsbündig" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>
                <AlignRight size={13} />
              </ToolBtn>
              <ToolBtn title="Blocksatz" active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()}>
                <AlignJustify size={13} />
              </ToolBtn>
              <Sep />

              {/* Listen */}
              <ToolBtn title="Aufzählung" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
                <List size={13} />
              </ToolBtn>
              <ToolBtn title="Nummerierte Liste" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
                <ListOrdered size={13} />
              </ToolBtn>
              <ToolBtn title="Zitat" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
                <Quote size={13} />
              </ToolBtn>
              <Sep />

              {/* Link einfügen */}
              <ToolBtn title="Link einfügen / bearbeiten" active={editor.isActive('link')} onClick={insertLink}>
                <Link2 size={13} />
              </ToolBtn>

              {/* Bild einfügen (Upload + URL) */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) insertImageFromFile(file);
                  e.target.value = '';
                }}
              />
              <ToolBtn title="Bild von URL einfügen" onClick={insertImageFromUrl}>
                <ImageIcon size={13} />
              </ToolBtn>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-[10px] px-1.5 h-7 rounded hover:bg-gray-200 text-gray-600 ml-0.5"
                title="Bild von Datei hochladen (max 500 KB)"
              >
                Hochladen
              </button>
              <Sep />

              {/* Trennlinie */}
              <ToolBtn title="Horizontale Trennlinie" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                  <rect x="1" y="7" width="14" height="2" rx="1" />
                </svg>
              </ToolBtn>

              {/* Formatierung entfernen */}
              <ToolBtn title="Formatierung entfernen" onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}>
                <Eraser size={13} />
              </ToolBtn>
            </div>

            {/* Editor-Bereich */}
            <div className="px-4 py-3">
              <EditorContent
                editor={editor}
                className={[
                  '[&_.ProseMirror]:min-h-[200px] [&_.ProseMirror]:outline-none',
                  '[&_.ProseMirror_a]:text-blue-600 [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:cursor-pointer',
                  '[&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_img]:rounded [&_.ProseMirror_img]:inline-block',
                  '[&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-gray-300 [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-gray-600 [&_.ProseMirror_blockquote]:italic',
                  '[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5',
                  '[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5',
                  '[&_.ProseMirror_hr]:border-gray-300 [&_.ProseMirror_hr]:my-3',
                  '[&_.ProseMirror_p]:my-0.5',
                ].join(' ')}
              />
              <p className="mt-2 text-[10px] text-gray-400">
                💡 Tipp: Bilder können per Drag & Drop eingefügt werden. Empfohlene Größe: max 500 KB für leichtgewichtige E-Mails.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Auto-Insert Optionen */}
      <div className="space-y-3 py-3 border-t border-gray-100">
        <p className="text-sm font-medium text-gray-700">Signatur automatisch einfügen</p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={autoNew}
            onChange={(e) => setAutoNew(e.target.checked)}
            className="rounded border-gray-300 text-accent focus:ring-accent w-4 h-4"
          />
          <span className="text-sm text-gray-700">Bei neuen E-Mails</span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={autoReply}
            onChange={(e) => setAutoReply(e.target.checked)}
            className="rounded border-gray-300 text-accent focus:ring-accent w-4 h-4"
          />
          <span className="text-sm text-gray-700">Bei Antworten und Weiterleitungen</span>
        </label>
      </div>

      {/* Speichern */}
      <button
        type="button"
        onClick={() => mutation.mutate()}
        className="btn-primary"
        disabled={mutation.isPending}
      >
        {mutation.isPending
          ? <><Loader2 size={14} className="animate-spin" /> Speichern…</>
          : 'Speichern'}
      </button>
    </div>
  );
}
