import { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Minus, Maximize2, Send, Paperclip, Save, Loader2,
  Bold, Italic, Underline as LucideUnderline, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Link2, Undo2, Redo2, Eraser,
  ChevronDown, Quote, Code2, Highlighter, Type, FileIcon,
} from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import UnderlineExt from '@tiptap/extension-underline';
import LinkExt from '@tiptap/extension-link';
import TextAlignExt from '@tiptap/extension-text-align';
import { Color } from '@tiptap/extension-color';
import TextStyle from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import FontFamilyExt from '@tiptap/extension-font-family';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import toast from 'react-hot-toast';

// ── Farbpaletten ──────────────────────────────────────────────────────────────
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

// ── Farbpaletten-Popover ──────────────────────────────────────────────────────
function ColorPicker({
  colors,
  onSelect,
  onClose,
  currentColor,
}: {
  colors: string[];
  onSelect: (color: string) => void;
  onClose: () => void;
  currentColor?: string;
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
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-2.5 z-[300]"
      style={{ minWidth: 168 }}
    >
      <div className="grid grid-cols-6 gap-1">
        {colors.map((c) => (
          <button
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
        onMouseDown={(e) => { e.preventDefault(); onSelect(''); onClose(); }}
        className="mt-2 pt-2 border-t border-gray-100 w-full text-xs text-gray-500 hover:text-gray-800 text-center block"
      >
        Farbe entfernen
      </button>
    </div>
  );
}

// ── Block-Typ-Dropdown (Normal / Überschrift / Code) ──────────────────────────
const BLOCK_TYPES = [
  { label: 'Normal',        cmd: 'paragraph',  size: 'text-sm' },
  { label: 'Überschrift 1', cmd: 'h1',         size: 'text-2xl font-bold' },
  { label: 'Überschrift 2', cmd: 'h2',         size: 'text-xl font-semibold' },
  { label: 'Überschrift 3', cmd: 'h3',         size: 'text-base font-semibold' },
  { label: 'Codeblock',     cmd: 'codeBlock',  size: 'font-mono text-xs text-red-600' },
] as const;

type BlockCmd = typeof BLOCK_TYPES[number]['cmd'];

function BlockTypeDropdown({ editor }: { editor: ReturnType<typeof useEditor> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function getActiveLabel(): string {
    if (!editor) return 'Normal';
    if (editor.isActive('heading', { level: 1 })) return 'Überschrift 1';
    if (editor.isActive('heading', { level: 2 })) return 'Überschrift 2';
    if (editor.isActive('heading', { level: 3 })) return 'Überschrift 3';
    if (editor.isActive('codeBlock')) return 'Codeblock';
    return 'Normal';
  }

  function apply(cmd: BlockCmd) {
    if (!editor) return;
    setOpen(false);
    if (cmd === 'paragraph')  editor.chain().focus().setParagraph().run();
    else if (cmd === 'h1')    editor.chain().focus().setHeading({ level: 1 }).run();
    else if (cmd === 'h2')    editor.chain().focus().setHeading({ level: 2 }).run();
    else if (cmd === 'h3')    editor.chain().focus().setHeading({ level: 3 }).run();
    else if (cmd === 'codeBlock') editor.chain().focus().setCodeBlock().run();
  }

  const active = getActiveLabel();

  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className="flex items-center gap-1 px-2 h-6 text-xs rounded hover:bg-gray-100 border border-transparent hover:border-gray-200 min-w-[96px]"
      >
        <span className="flex-1 text-left text-gray-700">{active}</span>
        <ChevronDown size={11} className="shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-[300] min-w-[156px]">
          {BLOCK_TYPES.map(({ label, cmd, size }) => (
            <button
              key={cmd}
              onMouseDown={(e) => { e.preventDefault(); apply(cmd); }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-gray-50 ${size} ${
                active === label ? 'text-blue-600' : 'text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Schriftarten-Dropdown ─────────────────────────────────────────────────────
const FONT_FAMILIES = [
  { label: 'Standard',        value: '' },
  { label: 'Arial',           value: 'Arial, sans-serif' },
  { label: 'Calibri',         value: 'Calibri, sans-serif' },
  { label: 'Georgia',         value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Courier New',     value: '"Courier New", monospace' },
  { label: 'Verdana',         value: 'Verdana, sans-serif' },
  { label: 'Trebuchet MS',    value: '"Trebuchet MS", sans-serif' },
] as const;

function FontFamilyDropdown({ editor }: { editor: ReturnType<typeof useEditor> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const currentFont = editor?.getAttributes('textStyle').fontFamily as string | undefined;
  const activeLabel = FONT_FAMILIES.find((f) => f.value === currentFont)?.label ?? 'Schriftart';

  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className="flex items-center gap-1 px-2 h-6 text-xs rounded hover:bg-gray-100 border border-transparent hover:border-gray-200 min-w-[88px]"
      >
        <span className="flex-1 text-left text-gray-700 truncate" style={currentFont ? { fontFamily: currentFont } : undefined}>
          {activeLabel}
        </span>
        <ChevronDown size={11} className="shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-[300] min-w-[160px]">
          {FONT_FAMILIES.map(({ label, value }) => (
            <button
              key={label}
              onMouseDown={(e) => {
                e.preventDefault();
                setOpen(false);
                if (!value) {
                  editor?.chain().focus().unsetFontFamily().run();
                } else {
                  editor?.chain().focus().setFontFamily(value).run();
                }
              }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-gray-50 text-sm ${
                currentFont === value ? 'text-blue-600' : 'text-gray-700'
              }`}
              style={value ? { fontFamily: value } : undefined}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Trennlinie ────────────────────────────────────────────────────────────────
function Sep() {
  return <div className="w-px h-5 bg-gray-200 mx-0.5 shrink-0" />;
}

// ── Toolbar-Button ────────────────────────────────────────────────────────────
function ToolBtn({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(e); }}
      title={title}
      disabled={disabled}
      className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
        active
          ? 'bg-blue-100 text-blue-700'
          : 'hover:bg-gray-100 text-gray-700'
      } disabled:opacity-30 disabled:cursor-default`}
    >
      {children}
    </button>
  );
}

// ── Empfänger-Autocomplete ────────────────────────────────────────────────────
interface ContactSuggest {
  id: string;
  displayName: string;
  email: string;
  company?: string;
}

function RecipientInput({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [debouncedQ, setDebouncedQ] = useState('');
  const [showSug, setShowSug]       = useState(false);
  const [activeIdx, setActiveIdx]   = useState(0);
  const containerRef  = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Last typed fragment (after the final comma)
  const getFragment = (v: string) => {
    const parts = v.split(',');
    return (parts[parts.length - 1] ?? '').trimStart();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    onChange(newVal);
    const frag = getFragment(newVal);
    setActiveIdx(0);
    if (frag.length >= 1) {
      setShowSug(true);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => setDebouncedQ(frag), 220);
    } else {
      setShowSug(false);
      setDebouncedQ('');
    }
  };

  const { data: contacts } = useQuery({
    queryKey: ['contact-suggest', debouncedQ],
    queryFn: () => api.get<ContactSuggest[]>(`/contacts?q=${encodeURIComponent(debouncedQ)}`),
    enabled: debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  const suggestions = (contacts ?? []).filter((c) => !!c.email).slice(0, 8);

  const pickSuggestion = useCallback((c: ContactSuggest) => {
    const display = c.displayName ? `${c.displayName} <${c.email}>` : c.email;
    // Replace last fragment with selected contact
    const parts = value.split(',').map((p) => p.trimStart());
    parts[parts.length - 1] = display;
    onChange(parts.filter(Boolean).join(', ') + ', ');
    setShowSug(false);
    setDebouncedQ('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [value, onChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSug || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const s = suggestions[activeIdx];
      if (s) { e.preventDefault(); pickSuggestion(s); }
    } else if (e.key === 'Escape') {
      setShowSug(false);
    }
  };

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSug(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          const frag = getFragment(value);
          if (frag.length >= 1 && suggestions.length > 0) setShowSug(true);
        }}
        className="w-full text-sm outline-none bg-transparent"
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {showSug && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-[400] max-h-52 overflow-y-auto">
          {suggestions.map((c, i) => (
            <button
              key={c.id}
              onMouseDown={(e) => { e.preventDefault(); pickSuggestion(c); }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                i === activeIdx ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
            >
              <div className="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center text-xs font-semibold text-accent shrink-0 uppercase">
                {(c.displayName || c.email)[0]}
              </div>
              <div className="min-w-0 flex-1">
                {c.displayName && (
                  <div className="text-sm font-medium text-gray-900 truncate">{c.displayName}</div>
                )}
                <div className={`truncate ${c.displayName ? 'text-xs text-gray-500' : 'text-sm text-gray-900'}`}>{c.email}</div>
                {c.company && (
                  <div className="text-xs text-gray-400 truncate">{c.company}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ComposeWindow ─────────────────────────────────────────────────────────────
export function ComposeWindow() {
  const qc = useQueryClient();
  const { closeCompose, composeCtx } = useUiStore();

  // Betreff-Präfix je nach Modus
  const subjectPrefix =
    composeCtx?.mode === 'reply' || composeCtx?.mode === 'replyAll' ? 'Re: ' :
    composeCtx?.mode === 'forward' ? 'Fwd: ' : '';
  const initialSubject = composeCtx?.subject
    ? (composeCtx.subject.match(/^(Re|Fwd|AW|WG):/i) ? composeCtx.subject : `${subjectPrefix}${composeCtx.subject}`)
    : '';

  const initialTo =
    composeCtx?.mode === 'reply' || composeCtx?.mode === 'replyAll'
      ? composeCtx?.fromAddr ?? ''
      : (composeCtx?.toAddrs ?? []).join(', ');
  const initialCc = composeCtx?.mode === 'replyAll' ? (composeCtx?.ccAddrs ?? []).join(', ') : '';

  const [minimized, setMinimized] = useState(false);
  const [to, setTo]           = useState(initialTo);
  const [cc, setCc]           = useState(initialCc);
  const [bcc, setBcc]         = useState('');
  const [showCc, setShowCc]   = useState(!!initialCc);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [inReplyTo]           = useState(composeCtx?.mode === 'reply' || composeCtx?.mode === 'replyAll' ? composeCtx?.id : undefined);
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const signatureInserted = useRef(false);

  const [showTextColor,  setShowTextColor]  = useState(false);
  const [showHighlight,  setShowHighlight]  = useState(false);

  const { data: sigData } = useQuery({
    queryKey: ['user', 'signature'],
    queryFn: () => api.get<{ signature: string; autoNew: boolean; autoReply: boolean }>('/user/signature'),
  });

  const editor = useEditor({
    extensions: [
      StarterKit,
      UnderlineExt,
      LinkExt.configure({ openOnClick: false }),
      TextAlignExt.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      FontFamilyExt,
    ],
    content: '',
    editorProps: {
      attributes: { class: 'outline-none min-h-[360px] text-sm leading-relaxed' },
    },
  });

  // Auto-Signatur + zitierter Vortext einfügen sobald Editor + Signaturdaten bereit sind
  useEffect(() => {
    if (!editor || !sigData || signatureInserted.current) return;
    signatureInserted.current = true;
    const isReply   = composeCtx?.mode === 'reply' || composeCtx?.mode === 'replyAll';
    const isForward = composeCtx?.mode === 'forward';
    const shouldInsert = (isReply || isForward) ? sigData.autoReply : sigData.autoNew;
    const sig = shouldInsert && sigData.signature ? sigData.signature : '';

    let quoted = '';
    if ((isReply || isForward) && composeCtx?.bodyHtml) {
      const headerLine = isForward
        ? `Weitergeleitete Nachricht von ${composeCtx.fromAddr ?? ''}`
        : `Am ${new Date().toLocaleString('de-DE')} schrieb ${composeCtx.fromAddr ?? ''}:`;
      quoted = `<blockquote style="border-left:2px solid #ccc;padding-left:12px;margin:0;color:#555">
        <p style="margin:0 0 8px 0;font-size:0.85em;color:#888">${headerLine}</p>
        ${composeCtx.bodyHtml}
      </blockquote>`;
    }

    if (!sig && !quoted) return;
    editor.commands.setContent(`<p></p>${sig}${quoted ? `<p></p>${quoted}` : ''}`);
    editor.commands.focus('start');
  }, [editor, sigData, composeCtx]);

  // Link einfügen / bearbeiten
  const handleLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    // eslint-disable-next-line no-alert
    const url = window.prompt('URL eingeben:', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor.chain().focus().setLink({ href: url.trim() }).run();
    }
  }, [editor]);

  const sendMutation = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('to',       to.split(',').map((s) => s.trim()).filter(Boolean).join(','));
      form.append('cc',       cc.split(',').map((s) => s.trim()).filter(Boolean).join(','));
      form.append('bcc',      bcc.split(',').map((s) => s.trim()).filter(Boolean).join(','));
      form.append('subject',  subject);
      form.append('bodyHtml', editor?.getHTML() ?? '');
      form.append('bodyText', editor?.getText() ?? '');
      if (inReplyTo) form.append('inReplyTo', inReplyTo);
      for (const file of attachments) form.append('attachments', file);
      return api.postForm<{ ok: boolean }>('/mail/send', form);
    },
    onSuccess: () => {
      toast.success('Nachricht gesendet');
      qc.invalidateQueries({ queryKey: ['messages'] });
      closeCompose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Minimierter Zustand ────────────────────────────────────────────────────
  if (minimized) {
    return (
      <div className="fixed bottom-0 right-4 w-72 bg-gray-800 text-white rounded-t-lg shadow-xl z-50">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium truncate">{subject || 'Neue Nachricht'}</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setMinimized(false)} className="p-0.5 hover:bg-white/20 rounded" title="Vergrößern">
              <Maximize2 size={13} />
            </button>
            <button onClick={closeCompose} className="p-0.5 hover:bg-white/20 rounded" title="Schließen">
              <X size={13} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Aktive Farben für Swatch-Vorschau
  const currentTextColor  = editor?.getAttributes('textStyle').color as string | undefined;
  const currentHighlight  = editor?.getAttributes('highlight').color as string | undefined;

  return (
    <div
      className="fixed bottom-0 right-4 w-[880px] max-w-[calc(100vw-2rem)] bg-white shadow-2xl border border-gray-300 rounded-t-lg z-50 flex flex-col animate-fly-in"
      style={{ maxHeight: '92vh', height: '78vh' }}
    >
      {/* ── Titelleiste ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800 text-white rounded-t-lg shrink-0">
        <span className="text-sm font-medium truncate">{subject || 'Neue Nachricht'}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setMinimized(true)} className="p-0.5 hover:bg-white/20 rounded" title="Minimieren">
            <Minus size={13} />
          </button>
          <button onClick={closeCompose} className="p-0.5 hover:bg-white/20 rounded" title="Schließen">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Kopffelder (An / CC / BCC / Betreff) ────────────────────────────── */}
      <div className="border-b border-gray-100 shrink-0">
        {/* An */}
        <div className="flex items-center border-b border-gray-100 px-3 py-1.5 gap-2">
          <span className="text-xs text-gray-400 w-10 shrink-0">An:</span>
          <RecipientInput value={to} onChange={setTo} placeholder="Empfänger..." />
          <div className="flex gap-3 text-xs text-blue-600 shrink-0">
            {!showCc  && <button type="button" onClick={() => setShowCc(true)}>CC</button>}
            {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>BCC</button>}
          </div>
        </div>

        {/* CC */}
        {showCc && (
          <div className="flex items-center border-b border-gray-100 px-3 py-1.5 gap-2">
            <span className="text-xs text-gray-400 w-10 shrink-0">CC:</span>
            <RecipientInput value={cc} onChange={setCc} placeholder="CC..." autoFocus />
          </div>
        )}

        {/* BCC */}
        {showBcc && (
          <div className="flex items-center border-b border-gray-100 px-3 py-1.5 gap-2">
            <span className="text-xs text-gray-400 w-10 shrink-0">BCC:</span>
            <RecipientInput value={bcc} onChange={setBcc} placeholder="BCC..." autoFocus />
          </div>
        )}

        {/* Betreff */}
        <div className="flex items-center px-3 py-1.5 gap-2">
          <span className="text-xs text-gray-400 w-10 shrink-0">Betreff:</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1 text-sm outline-none font-medium"
            placeholder="Betreff..."
          />
        </div>
      </div>

      {/* ── Formatierungsleiste ──────────────────────────────────────────────── */}
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-gray-100 shrink-0 bg-gray-50/60">

        {/* Rückgängig / Wiederholen */}
        <ToolBtn
          title="Rückgängig (Ctrl+Z)"
          disabled={!editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 size={13} />
        </ToolBtn>
        <ToolBtn
          title="Wiederholen (Ctrl+Y)"
          disabled={!editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 size={13} />
        </ToolBtn>

        <Sep />

        {/* Block-Typ */}
        {editor && <BlockTypeDropdown editor={editor} />}

        <Sep />

        {/* Schriftart */}
        {editor && <FontFamilyDropdown editor={editor} />}

        <Sep />

        {/* Fett / Kursiv / Unterstrichen / Durchgestrichen */}
        <ToolBtn
          title="Fett (Ctrl+B)"
          active={!!editor?.isActive('bold')}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold size={13} />
        </ToolBtn>
        <ToolBtn
          title="Kursiv (Ctrl+I)"
          active={!!editor?.isActive('italic')}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic size={13} />
        </ToolBtn>
        <ToolBtn
          title="Unterstrichen (Ctrl+U)"
          active={!!editor?.isActive('underline')}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <LucideUnderline size={13} />
        </ToolBtn>
        <ToolBtn
          title="Durchgestrichen"
          active={!!editor?.isActive('strike')}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={13} />
        </ToolBtn>

        <Sep />

        {/* Schriftfarbe */}
        <div className="relative">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              setShowTextColor((s) => !s);
              setShowHighlight(false);
            }}
            title="Schriftfarbe"
            className="w-7 h-6 flex flex-col items-center justify-center rounded hover:bg-gray-100 px-0.5"
          >
            <Type size={11} className="text-gray-700 shrink-0" />
            <div
              className="w-5 h-1 rounded-sm"
              style={{ backgroundColor: currentTextColor ?? '#000000' }}
            />
          </button>
          {showTextColor && (
            <ColorPicker
              colors={TEXT_COLORS}
              currentColor={currentTextColor}
              onSelect={(c) => {
                if (!c) editor?.chain().focus().unsetColor().run();
                else     editor?.chain().focus().setColor(c).run();
              }}
              onClose={() => setShowTextColor(false)}
            />
          )}
        </div>

        {/* Markierungsfarbe (Highlight) */}
        <div className="relative">
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              setShowHighlight((s) => !s);
              setShowTextColor(false);
            }}
            title="Markierungsfarbe"
            className="w-7 h-6 flex flex-col items-center justify-center rounded hover:bg-gray-100 px-0.5"
          >
            <Highlighter size={11} className="text-gray-700 shrink-0" />
            <div
              className="w-5 h-1 rounded-sm"
              style={{ backgroundColor: currentHighlight ?? '#ffff00' }}
            />
          </button>
          {showHighlight && (
            <ColorPicker
              colors={HIGHLIGHT_COLORS}
              currentColor={currentHighlight}
              onSelect={(c) => {
                if (!c) editor?.chain().focus().unsetHighlight().run();
                else     editor?.chain().focus().toggleHighlight({ color: c }).run();
              }}
              onClose={() => setShowHighlight(false)}
            />
          )}
        </div>

        <Sep />

        {/* Link */}
        <ToolBtn
          title="Link einfügen / bearbeiten (Ctrl+K)"
          active={!!editor?.isActive('link')}
          onClick={handleLink}
        >
          <Link2 size={13} />
        </ToolBtn>

        <Sep />

        {/* Textausrichtung */}
        <ToolBtn
          title="Linksbündig"
          active={!!editor?.isActive({ textAlign: 'left' })}
          onClick={() => editor?.chain().focus().setTextAlign('left').run()}
        >
          <AlignLeft size={13} />
        </ToolBtn>
        <ToolBtn
          title="Zentriert"
          active={!!editor?.isActive({ textAlign: 'center' })}
          onClick={() => editor?.chain().focus().setTextAlign('center').run()}
        >
          <AlignCenter size={13} />
        </ToolBtn>
        <ToolBtn
          title="Rechtsbündig"
          active={!!editor?.isActive({ textAlign: 'right' })}
          onClick={() => editor?.chain().focus().setTextAlign('right').run()}
        >
          <AlignRight size={13} />
        </ToolBtn>
        <ToolBtn
          title="Blocksatz"
          active={!!editor?.isActive({ textAlign: 'justify' })}
          onClick={() => editor?.chain().focus().setTextAlign('justify').run()}
        >
          <AlignJustify size={13} />
        </ToolBtn>

        <Sep />

        {/* Listen */}
        <ToolBtn
          title="Aufzählungsliste"
          active={!!editor?.isActive('bulletList')}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List size={13} />
        </ToolBtn>
        <ToolBtn
          title="Nummerierte Liste"
          active={!!editor?.isActive('orderedList')}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={13} />
        </ToolBtn>

        {/* Einzug */}
        <ToolBtn
          title="Einzug verringern"
          onClick={() => editor?.chain().focus().liftListItem('listItem').run()}
        >
          {/* ⇤ */}
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
            <path d="M2 3h12v1.5H2V3zm5 3.5L3.5 8 7 9.5V7h7V6H7V5L3.5 6.5zm-5 5.5h12V13.5H2V12z"/>
          </svg>
        </ToolBtn>
        <ToolBtn
          title="Einzug erhöhen"
          onClick={() => editor?.chain().focus().sinkListItem('listItem').run()}
        >
          {/* ⇥ */}
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
            <path d="M2 3h12v1.5H2V3zm4 3.5v1H2V9h4v1.5l3.5-1.5L6 6.5zm-4 5.5h12V13.5H2V12z"/>
          </svg>
        </ToolBtn>

        <Sep />

        {/* Zitat */}
        <ToolBtn
          title="Zitat (Blockquote)"
          active={!!editor?.isActive('blockquote')}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={13} />
        </ToolBtn>

        {/* Inline-Code */}
        <ToolBtn
          title="Inline-Code"
          active={!!editor?.isActive('code')}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code2 size={13} />
        </ToolBtn>

        {/* Trennlinie einfügen */}
        <ToolBtn
          title="Horizontale Trennlinie einfügen"
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
        >
          {/* — */}
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
            <rect x="1" y="7" width="14" height="2" rx="1" />
          </svg>
        </ToolBtn>

        <Sep />

        {/* Formatierung entfernen */}
        <ToolBtn
          title="Formatierung entfernen"
          onClick={() => editor?.chain().focus().clearNodes().unsetAllMarks().run()}
        >
          <Eraser size={13} />
        </ToolBtn>
      </div>

      {/* ── Editor-Bereich ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent
          editor={editor}
          className={[
            'h-full px-4 py-3',
            // Headings
            '[&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h1]:mb-2 [&_.ProseMirror_h1]:mt-3',
            '[&_.ProseMirror_h2]:text-xl  [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-2',
            '[&_.ProseMirror_h3]:text-base [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h3]:mb-1 [&_.ProseMirror_h3]:mt-2',
            // Blockquote
            '[&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-gray-300 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:text-gray-500 [&_.ProseMirror_blockquote]:italic [&_.ProseMirror_blockquote]:my-2',
            // Listen
            '[&_.ProseMirror_ul]:list-disc   [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_ul]:my-1',
            '[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_ol]:my-1',
            '[&_.ProseMirror_li]:my-0.5',
            // Inline-Code
            '[&_.ProseMirror_:not(pre)>code]:bg-gray-100 [&_.ProseMirror_:not(pre)>code]:text-red-600 [&_.ProseMirror_:not(pre)>code]:font-mono [&_.ProseMirror_:not(pre)>code]:text-xs [&_.ProseMirror_:not(pre)>code]:px-1.5 [&_.ProseMirror_:not(pre)>code]:py-0.5 [&_.ProseMirror_:not(pre)>code]:rounded',
            // Codeblock
            '[&_.ProseMirror_pre]:bg-gray-100 [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:font-mono [&_.ProseMirror_pre]:text-xs [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:my-2',
            // Links
            '[&_.ProseMirror_a]:text-blue-600 [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:cursor-pointer',
            // HR
            '[&_.ProseMirror_hr]:border-gray-200 [&_.ProseMirror_hr]:my-4',
            // Paragraph-Abstand
            '[&_.ProseMirror_p]:mb-1',
          ].join(' ')}
        />
      </div>

      {/* ── Anhangsliste ──────────────────────────────────────────────────────── */}
      {attachments.length > 0 && (
        <div className="border-t border-gray-100 px-3 py-2 flex flex-wrap gap-2 shrink-0 bg-gray-50/40">
          {attachments.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-full px-2.5 py-1 text-xs text-gray-700 shadow-sm"
            >
              <FileIcon size={12} className="text-blue-500 shrink-0" />
              <span className="max-w-[140px] truncate" title={file.name}>{file.name}</span>
              <span className="text-gray-400 shrink-0">
                {file.size >= 1024 * 1024
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                  : `${Math.round(file.size / 1024)} KB`}
              </span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-gray-400 hover:text-red-500 shrink-0"
                title="Anhang entfernen"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Aktionsleiste ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50/60 shrink-0">
        <div className="flex items-center gap-1">
          {/* Verstecktes File-Input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const newFiles = Array.from(e.target.files ?? []);
              if (newFiles.length) {
                setAttachments((prev) => [...prev, ...newFiles]);
              }
              // Reset so dieselbe Datei erneut gewählt werden kann
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn-ghost text-xs"
            title="Datei anhängen"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} />
            Anhang
            {attachments.length > 0 && (
              <span className="ml-0.5 bg-blue-500 text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center shrink-0">
                {attachments.length}
              </span>
            )}
          </button>
          <button type="button" className="btn-ghost text-xs" title="Als Entwurf speichern">
            <Save size={14} />
            Entwurf
          </button>
        </div>
        <button
          type="button"
          onClick={() => sendMutation.mutate()}
          disabled={sendMutation.isPending || !to.trim()}
          className="btn-primary text-xs min-w-[100px] justify-center"
        >
          {sendMutation.isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Senden…
            </>
          ) : (
            <>
              <Send size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" />
              Senden
            </>
          )}
        </button>
      </div>
    </div>
  );
}
