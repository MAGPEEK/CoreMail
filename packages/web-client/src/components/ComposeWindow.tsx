import { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Minus, Maximize2, Minimize2, Send, Paperclip, Loader2,
  Bold, Italic, Underline as LucideUnderline, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Link2, Undo2, Redo2, Eraser,
  ChevronDown, ChevronUp, Quote, Code2, Highlighter, Type, FileIcon,
  Smile, Image as ImageIcon, Lock, MoreVertical, Trash2, Clock,
  Type as TypeIcon, Calendar as CalendarIcon, Check,
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

// Emoji-Set (handpicked, top usage)
const EMOJI_SET = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😐',
  '😑', '😶', '🙄', '😏', '😣', '😥', '😮', '🤐', '😯', '😪',
  '😴', '😌', '😛', '😜', '😝', '🤤', '😒', '😓', '😔', '😕',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉',
  '👆', '🖕', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏',
  '🙌', '🤝', '🙏', '✍️', '💪', '❤️', '🧡', '💛', '💚', '💙',
  '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗',
  '💖', '💘', '💝', '🔥', '✨', '🎉', '🎊', '🎈', '🎁', '🏆',
];

// ── Farbpaletten-Popover ──────────────────────────────────────────────────────
function ColorPicker({
  colors,
  onSelect,
  onClose,
  currentColor,
  align = 'left',
}: {
  colors: string[];
  onSelect: (color: string) => void;
  onClose: () => void;
  currentColor?: string;
  align?: 'left' | 'right';
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
      className={`absolute bottom-full mb-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-2.5 z-[300] ${align === 'right' ? 'right-0' : 'left-0'}`}
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
        className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 w-full text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 text-center block"
      >
        Farbe entfernen
      </button>
    </div>
  );
}

// ── Block-Typ-Dropdown ────────────────────────────────────────────────────────
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
        className="flex items-center gap-1 px-2 h-6 text-xs rounded hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent min-w-[96px]"
      >
        <span className="flex-1 text-left text-gray-700 dark:text-gray-200">{active}</span>
        <ChevronDown size={11} className="shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 z-[300] min-w-[156px]">
          {BLOCK_TYPES.map(({ label, cmd, size }) => (
            <button
              key={cmd}
              onMouseDown={(e) => { e.preventDefault(); apply(cmd); }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 ${size} ${
                active === label ? 'text-blue-600' : 'text-gray-700 dark:text-gray-200'
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
  { label: 'Sans Serif',      value: '' },
  { label: 'Serif',           value: 'Georgia, serif' },
  { label: 'Arial',           value: 'Arial, sans-serif' },
  { label: 'Calibri',         value: 'Calibri, sans-serif' },
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
  const activeLabel = FONT_FAMILIES.find((f) => f.value === currentFont)?.label ?? 'Sans Serif';

  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className="flex items-center gap-1 px-2 h-6 text-xs rounded hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent min-w-[88px]"
      >
        <span className="flex-1 text-left text-gray-700 dark:text-gray-200 truncate" style={currentFont ? { fontFamily: currentFont } : undefined}>
          {activeLabel}
        </span>
        <ChevronDown size={11} className="shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 z-[300] min-w-[160px]">
          {FONT_FAMILIES.map(({ label, value }) => (
            <button
              key={label}
              onMouseDown={(e) => {
                e.preventDefault();
                setOpen(false);
                if (!value) editor?.chain().focus().unsetFontFamily().run();
                else        editor?.chain().focus().setFontFamily(value).run();
              }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 text-sm ${
                currentFont === value ? 'text-blue-600' : 'text-gray-700 dark:text-gray-200'
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
  return <div className="w-px h-5 bg-gray-200 dark:bg-gray-700 mx-0.5 shrink-0" />;
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
      className={`w-6 h-6 flex items-center justify-center rounded transition-all duration-100 active:scale-90 ${
        active
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200'
      } disabled:opacity-30 disabled:cursor-default`}
    >
      {children}
    </button>
  );
}

// ── Footer-Action-Button (etwas größer, mit hover-glow) ──────────────────────
function FooterBtn({ onClick, title, active = false, children }: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-150 active:scale-90 ${
        active
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
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
  isGroup?: boolean;
}

interface GalGroup {
  id: string;
  displayName: string;
  email: string;
}

function RecipientInput({ value, onChange, placeholder, autoFocus }: {
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

  const { data: galGroups } = useQuery({
    queryKey: ['gal-groups-suggest', debouncedQ],
    queryFn: () => api.get<GalGroup[]>('/admin/groups/gal'),
    enabled: debouncedQ.length >= 1,
    staleTime: 60_000,
  });

  const matchingGroups: ContactSuggest[] = (galGroups ?? [])
    .filter((g) => {
      const q = debouncedQ.toLowerCase();
      return g.email.toLowerCase().includes(q) || g.displayName.toLowerCase().includes(q);
    })
    .map((g) => ({ id: g.id, displayName: g.displayName, email: g.email, isGroup: true }));

  const suggestions = [
    ...(contacts ?? []).filter((c) => !!c.email),
    ...matchingGroups,
  ].slice(0, 8);

  const pickSuggestion = useCallback((c: ContactSuggest) => {
    const display = c.displayName ? `${c.displayName} <${c.email}>` : c.email;
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
        className="w-full text-sm outline-none bg-transparent dark:text-gray-100"
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {showSug && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-[400] max-h-52 overflow-y-auto">
          {suggestions.map((c, i) => (
            <button
              key={c.id + (c.isGroup ? '-grp' : '')}
              onMouseDown={(e) => { e.preventDefault(); pickSuggestion(c); }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                i === activeIdx ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 uppercase ${
                c.isGroup ? 'bg-purple-100 text-purple-700' : 'bg-accent/15 text-accent'
              }`}>
                {c.isGroup ? '⊕' : (c.displayName || c.email)[0]}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {c.displayName && (
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{c.displayName}</span>
                  )}
                  {c.isGroup && (
                    <span className="text-[10px] bg-purple-100 text-purple-600 px-1 py-0.5 rounded shrink-0">[Gruppe]</span>
                  )}
                </div>
                <div className={`truncate ${c.displayName ? 'text-xs text-gray-500 dark:text-gray-400' : 'text-sm text-gray-900 dark:text-gray-100'}`}>{c.email}</div>
                {c.company && !c.isGroup && (
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

// ── Emoji-Picker ──────────────────────────────────────────────────────────────
function EmojiPicker({ onSelect, onClose }: { onSelect: (e: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute bottom-full mb-1 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 z-[300] w-[280px]">
      <div className="grid grid-cols-10 gap-0.5 max-h-48 overflow-y-auto">
        {EMOJI_SET.map((e) => (
          <button key={e} onClick={() => { onSelect(e); onClose(); }}
            className="text-lg w-7 h-7 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-transform hover:scale-125 active:scale-95">
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Schedule-Send-Picker ──────────────────────────────────────────────────────
interface ScheduleOption { label: string; sub: string; date: Date }

function computeSchedulePresets(): ScheduleOption[] {
  const now = new Date();
  const tomorrowMorning = new Date(now); tomorrowMorning.setDate(now.getDate() + 1); tomorrowMorning.setHours(8, 0, 0, 0);
  const tomorrowNoon    = new Date(now); tomorrowNoon.setDate(now.getDate() + 1);    tomorrowNoon.setHours(13, 0, 0, 0);
  const nextMonday      = new Date(now);
  const dayDiff = (1 - now.getDay() + 7) % 7 || 7;
  nextMonday.setDate(now.getDate() + dayDiff); nextMonday.setHours(8, 0, 0, 0);
  const fmt = (d: Date) => d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return [
    { label: 'Morgen früh',     sub: fmt(tomorrowMorning), date: tomorrowMorning },
    { label: 'Morgen nachmittags', sub: fmt(tomorrowNoon), date: tomorrowNoon },
    { label: 'Nächsten Montag', sub: fmt(nextMonday),     date: nextMonday },
  ];
}

function SchedulePicker({ onPick, onClose }: { onPick: (d: Date) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState(() => {
    const d = new Date(); d.setHours(d.getHours() + 1); d.setMinutes(0);
    return d.toISOString().slice(0, 16);
  });
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  const presets = computeSchedulePresets();
  return (
    <div ref={ref} className="absolute bottom-full mb-1 left-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-2 z-[300] w-[320px]">
      <div className="px-3 pb-2 text-xs font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-100 dark:border-gray-700 mb-1 flex items-center gap-1.5">
        <Clock size={12} /> Senden planen
      </div>
      {presets.map((p) => (
        <button key={p.label} onClick={() => onPick(p.date)}
          className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between transition-colors group">
          <span className="text-sm text-gray-800 dark:text-gray-100 font-medium">{p.label}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{p.sub}</span>
        </button>
      ))}
      <div className="border-t border-gray-100 dark:border-gray-700 mt-1 pt-1">
        {!showCustom ? (
          <button onClick={() => setShowCustom(true)} className="w-full px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 text-sm text-left text-blue-600 dark:text-blue-400 flex items-center gap-2">
            <CalendarIcon size={13} /> Datum & Uhrzeit wählen…
          </button>
        ) : (
          <div className="px-3 py-2 space-y-2">
            <input type="datetime-local" value={customValue} onChange={(e) => setCustomValue(e.target.value)}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1.5" />
            <button onClick={() => onPick(new Date(customValue))} className="w-full btn-primary text-sm">
              <Check size={13} /> Planen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hauptkomponente: ComposeWindow
// ─────────────────────────────────────────────────────────────────────────────

type SizeMode = 'small' | 'large' | 'minimized';

export function ComposeWindow() {
  const qc = useQueryClient();
  const { closeCompose, composeCtx } = useUiStore();

  // ── Size-Mode + Drag-Position (nur für `small`) ────────────────────────────
  const [sizeMode, setSizeMode] = useState<SizeMode>('small');
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // ── Header-Drag (nur im small-Mode aktiv) ──────────────────────────────────
  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (sizeMode !== 'small') return;
    // Ignorieren wenn auf Button geklickt
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragStateRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: dragOffset?.x ?? 0, baseY: dragOffset?.y ?? 0,
    };
    const onMove = (m: MouseEvent) => {
      if (!dragStateRef.current) return;
      const dx = m.clientX - dragStateRef.current.startX;
      const dy = m.clientY - dragStateRef.current.startY;
      setDragOffset({ x: dragStateRef.current.baseX + dx, y: dragStateRef.current.baseY + dy });
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Initialwerte aus composeCtx ─────────────────────────────────────────────
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

  // ── Form-State ──────────────────────────────────────────────────────────────
  const [to, setTo]                 = useState(initialTo);
  const [cc, setCc]                 = useState(initialCc);
  const [bcc, setBcc]               = useState('');
  const [showCc, setShowCc]         = useState(!!initialCc);
  const [showBcc, setShowBcc]       = useState(false);
  const [subject, setSubject]       = useState(initialSubject);
  const [inReplyTo]                 = useState(composeCtx?.mode === 'reply' || composeCtx?.mode === 'replyAll' ? composeCtx?.id : undefined);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showFormatBar, setShowFormatBar] = useState(true);
  const [dragOver, setDragOver]     = useState(false);
  const fileInputRef                = useRef<HTMLInputElement>(null);
  const signatureInserted           = useRef(false);

  // Popover-States (mutually exclusive)
  const [openPopover, setOpenPopover] = useState<null | 'textColor' | 'highlight' | 'emoji' | 'schedule' | 'sendMenu' | 'moreMenu'>(null);

  const { data: sigData } = useQuery({
    queryKey: ['user', 'signature'],
    queryFn: () => api.get<{ signature: string; autoNew: boolean; autoReply: boolean }>('/user/signature'),
  });

  // ── Tiptap-Editor ───────────────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit,
      UnderlineExt,
      LinkExt.configure({ openOnClick: false }),
      TextAlignExt.configure({ types: ['heading', 'paragraph'] }),
      TextStyle, Color, Highlight.configure({ multicolor: true }), FontFamilyExt,
    ],
    content: '',
    editorProps: {
      attributes: { class: 'outline-none text-sm leading-relaxed' },
    },
  });

  // ── Auto-Signatur + Quoted-Text ─────────────────────────────────────────────
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

  // ── Auto-Save Status (visuell, kein echter Draft-Endpoint) ─────────────────
  const [savedStatus, setSavedStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const lastChangeRef = useRef<number>(0);
  useEffect(() => {
    lastChangeRef.current = Date.now();
    setSavedStatus('saving');
    const t = setTimeout(() => setSavedStatus('saved'), 1800);
    return () => clearTimeout(t);
  }, [to, cc, bcc, subject, attachments]);

  // ── Link einfügen ───────────────────────────────────────────────────────────
  const handleLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    // eslint-disable-next-line no-alert
    const url = window.prompt('URL eingeben:', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim()) editor.chain().focus().unsetLink().run();
    else             editor.chain().focus().setLink({ href: url.trim() }).run();
  }, [editor]);

  // ── Bild einfügen ───────────────────────────────────────────────────────────
  const handleImage = useCallback(() => {
    if (!editor) return;
    // eslint-disable-next-line no-alert
    const url = window.prompt('Bild-URL eingeben:', 'https://');
    if (!url) return;
    editor.chain().focus().setHorizontalRule().insertContent(`<img src="${url}" alt="" style="max-width:100%" />`).run();
  }, [editor]);

  // ── Send-Mutation ───────────────────────────────────────────────────────────
  const sendMutation = useMutation({
    mutationFn: (scheduledAt?: Date) => {
      const form = new FormData();
      form.append('to',       to.split(',').map((s) => s.trim()).filter(Boolean).join(','));
      form.append('cc',       cc.split(',').map((s) => s.trim()).filter(Boolean).join(','));
      form.append('bcc',      bcc.split(',').map((s) => s.trim()).filter(Boolean).join(','));
      form.append('subject',  subject);
      form.append('bodyHtml', editor?.getHTML() ?? '');
      form.append('bodyText', editor?.getText() ?? '');
      if (inReplyTo) form.append('inReplyTo', inReplyTo);
      if (scheduledAt) form.append('scheduledAt', scheduledAt.toISOString());
      for (const file of attachments) form.append('attachments', file);
      return api.postForm<{ ok: boolean }>('/mail/send', form);
    },
    onSuccess: (_d, scheduledAt) => {
      toast.success(scheduledAt ? `Nachricht geplant für ${(scheduledAt as Date).toLocaleString('de-DE')}` : 'Nachricht gesendet');
      qc.invalidateQueries({ queryKey: ['messages'] });
      closeCompose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Discard ────────────────────────────────────────────────────────────────
  const handleDiscard = () => {
    const hasContent = to || cc || bcc || subject || (editor && editor.getText().trim().length > 0) || attachments.length > 0;
    if (hasContent && !confirm('Entwurf verwerfen?')) return;
    closeCompose();
  };

  // ── Tastatur-Shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+Enter → Senden
      if (isMod && e.key === 'Enter' && !sendMutation.isPending && to.trim()) {
        e.preventDefault();
        sendMutation.mutate(undefined);
      }
      // Cmd/Ctrl+Shift+C → CC einblenden
      if (isMod && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        setShowCc(true);
      }
      // Cmd/Ctrl+Shift+B → BCC einblenden
      if (isMod && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        setShowBcc(true);
      }
      // Escape → Schließen (nur wenn kein Popover offen)
      if (e.key === 'Escape' && !openPopover) {
        e.preventDefault();
        handleDiscard();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, sendMutation.isPending, openPopover]);

  // ── Drag & Drop Files in Editor ────────────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    // nur deaktivieren wenn wir das Fenster verlassen (relatedTarget außerhalb)
    const rt = e.relatedTarget as Node | null;
    if (!rt || !(e.currentTarget as Node).contains(rt)) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) setAttachments((prev) => [...prev, ...files]);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Minimierter Zustand
  if (sizeMode === 'minimized') {
    return (
      <div className="fixed bottom-0 right-4 w-72 bg-gray-800 text-white rounded-t-lg shadow-2xl z-50 animate-fly-in">
        <div className="flex items-center justify-between px-3 py-2.5">
          <button onClick={() => setSizeMode('small')} className="flex-1 text-left text-sm font-medium truncate hover:underline">
            {subject || 'Neue Nachricht'}
          </button>
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => setSizeMode('small')} className="p-1 hover:bg-white/20 rounded transition-colors" title="Wiederherstellen">
              <Maximize2 size={13} />
            </button>
            <button onClick={handleDiscard} className="p-1 hover:bg-white/20 rounded transition-colors" title="Schließen">
              <X size={13} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Container-Style für small vs large
  const containerClass = sizeMode === 'large'
    ? 'fixed inset-4 md:inset-8 m-auto bg-white dark:bg-gray-900 shadow-2xl border border-gray-300 dark:border-gray-700 rounded-lg z-50 flex flex-col animate-page-in'
    : 'fixed bottom-0 right-4 w-[600px] max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-900 shadow-2xl border border-gray-300 dark:border-gray-700 rounded-t-lg z-50 flex flex-col animate-fly-in';

  const containerStyle: React.CSSProperties = sizeMode === 'large'
    ? { maxWidth: '1100px', maxHeight: 'calc(100vh - 4rem)' }
    : { height: '640px', maxHeight: 'calc(100vh - 4rem)', ...(dragOffset ? { transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` } : {}) };

  const currentTextColor = editor?.getAttributes('textStyle').color as string | undefined;
  const currentHighlight = editor?.getAttributes('highlight').color as string | undefined;

  return (
    <div
      className={`${containerClass} transition-[width,height,inset] duration-300 ease-out`}
      style={containerStyle}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ── Drop-Overlay ─────────────────────────────────────────────────────── */}
      {dragOver && (
        <div className="absolute inset-0 z-[100] bg-blue-50/95 dark:bg-blue-900/40 border-4 border-dashed border-blue-400 rounded-lg flex flex-col items-center justify-center pointer-events-none animate-fade-in">
          <Paperclip size={48} className="text-blue-500 mb-3" />
          <p className="text-blue-700 dark:text-blue-200 font-semibold text-lg">Dateien hier ablegen zum Anhängen</p>
        </div>
      )}

      {/* ── Titelleiste ─────────────────────────────────────────────────────── */}
      <div
        onMouseDown={onHeaderMouseDown}
        className={`flex items-center justify-between px-3 py-2 bg-gray-800 text-white shrink-0 ${
          sizeMode === 'large' ? 'rounded-t-lg' : 'rounded-t-lg cursor-move'
        }`}
      >
        <span className="text-sm font-medium truncate select-none">{subject || 'Neue Nachricht'}</span>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => setSizeMode('minimized')} className="p-1 hover:bg-white/20 rounded transition-colors" title="Minimieren">
            <Minus size={14} />
          </button>
          <button
            onClick={() => setSizeMode((s) => s === 'large' ? 'small' : 'large')}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            title={sizeMode === 'large' ? 'Auf Pop-up verkleinern' : 'Vollbild'}
          >
            {sizeMode === 'large' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button onClick={handleDiscard} className="p-1 hover:bg-white/20 rounded transition-colors" title="Schließen (Esc)">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── Empfängerfelder ─────────────────────────────────────────────────── */}
      <div className="border-b border-gray-100 dark:border-gray-700 shrink-0">
        <div className="flex items-center border-b border-gray-100 dark:border-gray-700 px-3 py-2 gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400 w-10 shrink-0">An:</span>
          <RecipientInput value={to} onChange={setTo} placeholder="Empfänger..." />
          <div className="flex gap-3 text-xs text-blue-600 dark:text-blue-400 shrink-0">
            {!showCc  && <button type="button" onClick={() => setShowCc(true)}  className="hover:underline">Cc</button>}
            {!showBcc && <button type="button" onClick={() => setShowBcc(true)} className="hover:underline">Bcc</button>}
          </div>
        </div>
        {showCc && (
          <div className="flex items-center border-b border-gray-100 dark:border-gray-700 px-3 py-2 gap-2 animate-fade-in">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-10 shrink-0">Cc:</span>
            <RecipientInput value={cc} onChange={setCc} placeholder="Cc..." autoFocus />
            <button onClick={() => { setShowCc(false); setCc(''); }} className="text-gray-300 hover:text-red-500" title="Cc entfernen">
              <X size={12} />
            </button>
          </div>
        )}
        {showBcc && (
          <div className="flex items-center border-b border-gray-100 dark:border-gray-700 px-3 py-2 gap-2 animate-fade-in">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-10 shrink-0">Bcc:</span>
            <RecipientInput value={bcc} onChange={setBcc} placeholder="Bcc..." autoFocus />
            <button onClick={() => { setShowBcc(false); setBcc(''); }} className="text-gray-300 hover:text-red-500" title="Bcc entfernen">
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex items-center px-3 py-2 gap-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1 text-sm outline-none font-medium dark:bg-transparent dark:text-gray-100 placeholder:text-gray-400"
            placeholder="Betreff"
          />
        </div>
      </div>

      {/* ── Editor-Bereich ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <EditorContent
          editor={editor}
          className={[
            'min-h-full',
            '[&_.ProseMirror]:min-h-[200px] [&_.ProseMirror]:outline-none',
            '[&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h1]:mb-2 [&_.ProseMirror_h1]:mt-3',
            '[&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-2',
            '[&_.ProseMirror_h3]:text-base [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h3]:mb-1 [&_.ProseMirror_h3]:mt-2',
            '[&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-gray-300 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:text-gray-500 [&_.ProseMirror_blockquote]:italic [&_.ProseMirror_blockquote]:my-2',
            '[&_.ProseMirror_ul]:list-disc   [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_ul]:my-1',
            '[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_ol]:my-1',
            '[&_.ProseMirror_li]:my-0.5',
            '[&_.ProseMirror_:not(pre)>code]:bg-gray-100 [&_.ProseMirror_:not(pre)>code]:text-red-600 [&_.ProseMirror_:not(pre)>code]:font-mono [&_.ProseMirror_:not(pre)>code]:text-xs [&_.ProseMirror_:not(pre)>code]:px-1.5 [&_.ProseMirror_:not(pre)>code]:py-0.5 [&_.ProseMirror_:not(pre)>code]:rounded',
            '[&_.ProseMirror_pre]:bg-gray-100 [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:font-mono [&_.ProseMirror_pre]:text-xs [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:my-2',
            '[&_.ProseMirror_a]:text-blue-600 [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:cursor-pointer',
            '[&_.ProseMirror_hr]:border-gray-200 [&_.ProseMirror_hr]:my-4',
            '[&_.ProseMirror_p]:mb-1',
            '[&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_img]:rounded',
          ].join(' ')}
        />
      </div>

      {/* ── Anhangsliste ────────────────────────────────────────────────────── */}
      {attachments.length > 0 && (
        <div className="border-t border-gray-100 dark:border-gray-700 px-3 py-2 flex flex-wrap gap-2 shrink-0 bg-gray-50/40 dark:bg-gray-800/40 animate-fade-in">
          {attachments.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center gap-1.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-full px-2.5 py-1 text-xs text-gray-700 dark:text-gray-200 shadow-sm transition-all hover:shadow-md"
            >
              <FileIcon size={12} className="text-blue-500 shrink-0" />
              <span className="max-w-[160px] truncate" title={file.name}>{file.name}</span>
              <span className="text-gray-400 shrink-0">
                {file.size >= 1024 * 1024
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                  : `${Math.round(file.size / 1024)} KB`}
              </span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-gray-400 hover:text-red-500 shrink-0 transition-colors"
                title="Anhang entfernen"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Formatierungs-Toolbar (toggle via Aa-Button im Footer) ──────────── */}
      {showFormatBar && editor && (
        <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-t border-gray-100 dark:border-gray-700 shrink-0 bg-gray-50/60 dark:bg-gray-800/40 animate-fade-in">
          <ToolBtn title="Rückgängig (⌘Z)" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
            <Undo2 size={13} />
          </ToolBtn>
          <ToolBtn title="Wiederholen (⌘Y)" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
            <Redo2 size={13} />
          </ToolBtn>
          <Sep />
          <BlockTypeDropdown editor={editor} />
          <Sep />
          <FontFamilyDropdown editor={editor} />
          <Sep />
          <ToolBtn title="Fett (⌘B)" active={!!editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold size={13} />
          </ToolBtn>
          <ToolBtn title="Kursiv (⌘I)" active={!!editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic size={13} />
          </ToolBtn>
          <ToolBtn title="Unterstrichen (⌘U)" active={!!editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
            <LucideUnderline size={13} />
          </ToolBtn>
          <ToolBtn title="Durchgestrichen" active={!!editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <Strikethrough size={13} />
          </ToolBtn>
          <Sep />
          {/* Textfarbe */}
          <div className="relative">
            <button
              onMouseDown={(e) => { e.preventDefault(); setOpenPopover((p) => p === 'textColor' ? null : 'textColor'); }}
              title="Schriftfarbe"
              className="w-7 h-6 flex flex-col items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 px-0.5 transition-colors"
            >
              <Type size={11} className="text-gray-700 dark:text-gray-200 shrink-0" />
              <div className="w-5 h-1 rounded-sm" style={{ backgroundColor: currentTextColor ?? '#000000' }} />
            </button>
            {openPopover === 'textColor' && (
              <ColorPicker
                colors={TEXT_COLORS}
                currentColor={currentTextColor}
                onSelect={(c) => {
                  if (!c) editor.chain().focus().unsetColor().run();
                  else    editor.chain().focus().setColor(c).run();
                }}
                onClose={() => setOpenPopover(null)}
              />
            )}
          </div>
          {/* Highlight */}
          <div className="relative">
            <button
              onMouseDown={(e) => { e.preventDefault(); setOpenPopover((p) => p === 'highlight' ? null : 'highlight'); }}
              title="Markierungsfarbe"
              className="w-7 h-6 flex flex-col items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 px-0.5 transition-colors"
            >
              <Highlighter size={11} className="text-gray-700 dark:text-gray-200 shrink-0" />
              <div className="w-5 h-1 rounded-sm" style={{ backgroundColor: currentHighlight ?? '#ffff00' }} />
            </button>
            {openPopover === 'highlight' && (
              <ColorPicker
                colors={HIGHLIGHT_COLORS}
                currentColor={currentHighlight}
                onSelect={(c) => {
                  if (!c) editor.chain().focus().unsetHighlight().run();
                  else    editor.chain().focus().toggleHighlight({ color: c }).run();
                }}
                onClose={() => setOpenPopover(null)}
              />
            )}
          </div>
          <Sep />
          <ToolBtn title="Link einfügen (⌘K)" active={!!editor.isActive('link')} onClick={handleLink}>
            <Link2 size={13} />
          </ToolBtn>
          <Sep />
          <ToolBtn title="Linksbündig" active={!!editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>
            <AlignLeft size={13} />
          </ToolBtn>
          <ToolBtn title="Zentriert" active={!!editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
            <AlignCenter size={13} />
          </ToolBtn>
          <ToolBtn title="Rechtsbündig" active={!!editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>
            <AlignRight size={13} />
          </ToolBtn>
          <ToolBtn title="Blocksatz" active={!!editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()}>
            <AlignJustify size={13} />
          </ToolBtn>
          <Sep />
          <ToolBtn title="Aufzählung" active={!!editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List size={13} />
          </ToolBtn>
          <ToolBtn title="Nummeriert" active={!!editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrdered size={13} />
          </ToolBtn>
          <Sep />
          <ToolBtn title="Zitat" active={!!editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <Quote size={13} />
          </ToolBtn>
          <ToolBtn title="Inline-Code" active={!!editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code2 size={13} />
          </ToolBtn>
          <Sep />
          <ToolBtn title="Formatierung entfernen" onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}>
            <Eraser size={13} />
          </ToolBtn>
        </div>
      )}

      {/* ── Action-Footer ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0 rounded-b-lg">
        {/* Links: Send-Group */}
        <div className="flex items-center gap-2">
          {/* Send-Button mit Schedule-Dropdown */}
          <div className="flex shadow-sm rounded-full overflow-hidden">
            <button
              type="button"
              onClick={() => sendMutation.mutate(undefined)}
              disabled={sendMutation.isPending || !to.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 text-sm font-medium flex items-center gap-2 transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              title="Senden (⌘+Enter)"
            >
              {sendMutation.isPending
                ? <><Loader2 size={14} className="animate-spin" /> Senden…</>
                : <><Send size={14} /> Senden</>}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenPopover((p) => p === 'schedule' ? null : 'schedule')}
                disabled={sendMutation.isPending || !to.trim()}
                className="bg-blue-600 hover:bg-blue-700 text-white px-2 py-2 border-l border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Senden planen"
              >
                <ChevronUp size={14} />
              </button>
              {openPopover === 'schedule' && (
                <SchedulePicker
                  onPick={(d) => { setOpenPopover(null); sendMutation.mutate(d); }}
                  onClose={() => setOpenPopover(null)}
                />
              )}
            </div>
          </div>

          {/* Aa — Format-Toolbar Toggle */}
          <FooterBtn title={showFormatBar ? 'Formatierung ausblenden' : 'Formatierung einblenden'} active={showFormatBar} onClick={() => setShowFormatBar((s) => !s)}>
            <TypeIcon size={16} />
          </FooterBtn>

          {/* Anhang */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const newFiles = Array.from(e.target.files ?? []);
              if (newFiles.length) setAttachments((prev) => [...prev, ...newFiles]);
              e.target.value = '';
            }}
          />
          <FooterBtn title="Datei anhängen" onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={16} />
            {attachments.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-blue-600 text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center">
                {attachments.length}
              </span>
            )}
          </FooterBtn>

          {/* Link */}
          <FooterBtn title="Link einfügen (⌘K)" onClick={handleLink}>
            <Link2 size={16} />
          </FooterBtn>

          {/* Emoji */}
          <div className="relative">
            <FooterBtn title="Emoji einfügen" onClick={() => setOpenPopover((p) => p === 'emoji' ? null : 'emoji')}>
              <Smile size={16} />
            </FooterBtn>
            {openPopover === 'emoji' && (
              <EmojiPicker
                onSelect={(e) => editor?.chain().focus().insertContent(e).run()}
                onClose={() => setOpenPopover(null)}
              />
            )}
          </div>

          {/* Bild */}
          <FooterBtn title="Bild einfügen" onClick={handleImage}>
            <ImageIcon size={16} />
          </FooterBtn>

          {/* Confidential (Placeholder — Backend folgt in eigener Iteration) */}
          <FooterBtn title="Vertrauliche Nachricht (kommt bald)" onClick={() => toast('Vertraulicher Modus wird in einer zukünftigen Version verfügbar sein', { icon: '🔒' })}>
            <Lock size={16} />
          </FooterBtn>

          {/* More */}
          <div className="relative">
            <FooterBtn title="Weitere Optionen" onClick={() => setOpenPopover((p) => p === 'moreMenu' ? null : 'moreMenu')}>
              <MoreVertical size={16} />
            </FooterBtn>
            {openPopover === 'moreMenu' && (
              <div className="absolute bottom-full mb-1 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 z-[300] w-[240px]">
                <button
                  onClick={() => { setSizeMode((s) => s === 'large' ? 'small' : 'large'); setOpenPopover(null); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  {sizeMode === 'large' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  {sizeMode === 'large' ? 'Auf Pop-up verkleinern' : 'Vollbild'}
                </button>
                <button
                  onClick={() => { editor?.chain().focus().clearNodes().unsetAllMarks().run(); setOpenPopover(null); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <Eraser size={13} /> Formatierung entfernen
                </button>
                <button
                  onClick={() => { setShowCc((s) => !s); setOpenPopover(null); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="text-xs font-mono">Cc</span> Cc {showCc ? 'ausblenden' : 'einblenden'} <span className="ml-auto text-[10px] text-gray-400">⌘⇧C</span>
                </button>
                <button
                  onClick={() => { setShowBcc((s) => !s); setOpenPopover(null); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="text-xs font-mono">Bcc</span> Bcc {showBcc ? 'ausblenden' : 'einblenden'} <span className="ml-auto text-[10px] text-gray-400">⌘⇧B</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Rechts: Status + Trash */}
        <div className="flex items-center gap-2">
          {savedStatus === 'saving' && <span className="text-xs text-gray-400">Speichern…</span>}
          {savedStatus === 'saved' && <span className="text-xs text-gray-400">Entwurf gespeichert</span>}
          <button onClick={handleDiscard} className="w-9 h-9 rounded-full flex items-center justify-center text-gray-500 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 transition-all active:scale-90" title="Entwurf verwerfen">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
