import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mail, Copy, Check } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { copyToClipboard } from '../api/clipboard.js';

interface ContactHoverCardProps {
  /** E-Mail-Adresse */
  email: string;
  /** Anzeigename (falls bekannt) */
  name?: string;
  /** Anker-Element relativ zu dem die Karte erscheint */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Callback wenn die Karte geschlossen werden soll */
  onClose: () => void;
}

export function ContactHoverCard({ email, name, anchorRef, onClose }: ContactHoverCardProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ x: rect.left, y: rect.bottom + 4 });
  }, [anchorRef]);

  // Auto-Reposition wenn aus Viewport ragt
  useEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    let nx = pos.x;
    let ny = pos.y;
    if (r.right > window.innerWidth) nx = window.innerWidth - r.width - 8;
    if (r.bottom > window.innerHeight) ny = pos.y - r.height - 30;
    if (nx !== pos.x || ny !== pos.y) setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [pos.x, pos.y]);

  // Schließen wenn Maus weg
  const handleEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const handleLeave = () => {
    closeTimer.current = setTimeout(onClose, 100);
  };

  const copy = async () => {
    try {
      await copyToClipboard(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-[150] w-[260px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 animate-fly-in"
      style={{ left: pos.x, top: pos.y }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="flex items-start gap-3">
        <Avatar seed={email} size="lg" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm truncate">
            {name || email.split('@')[0]}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{email}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1">
        <a
          href={`mailto:${email}`}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded bg-accent text-white hover:opacity-90 transition-all duration-150 active:scale-95"
        >
          <Mail size={12} /> Mail senden
        </a>
        <button
          onClick={copy}
          className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-150 active:scale-95"
          title="Adresse kopieren"
        >
          {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
        </button>
      </div>
    </div>,
    document.body,
  );
}
