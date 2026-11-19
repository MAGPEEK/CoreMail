import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mail, Copy, Check } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { copyToClipboard } from '../api/clipboard.js';
import { usePhotoForAddress } from '../hooks/useUserPhoto.js';

interface ContactHoverCardProps {
  /** Email address */
  email: string;
  /** Display name (if known) */
  name?: string;
  /** Anchor element relative to which the card appears */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Callback when the card should be closed */
  onClose: () => void;
}

export function ContactHoverCard({ email, name, anchorRef, onClose }: ContactHoverCardProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const photoUrl = usePhotoForAddress(email);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ x: rect.left, y: rect.bottom + 4 });
  }, [anchorRef]);

  // Auto-reposition when overflowing the viewport
  useEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    let nx = pos.x;
    let ny = pos.y;
    if (r.right > window.innerWidth) nx = window.innerWidth - r.width - 8;
    if (r.bottom > window.innerHeight) ny = pos.y - r.height - 30;
    if (nx !== pos.x || ny !== pos.y) setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [pos.x, pos.y]);

  // Close when the mouse leaves
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
      className="fixed z-[150] w-[260px] bg-surface border border-line rounded-lg shadow-xl p-4 animate-fly-in"
      style={{ left: pos.x, top: pos.y }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="flex items-start gap-3">
        <Avatar seed={email} name={name} photoUrl={photoUrl} size="lg" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-fg text-sm truncate">
            {name || email.split('@')[0]}
          </p>
          <p className="text-xs text-fg-subtle truncate">{email}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1">
        <a
          href={`mailto:${email}`}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded bg-accent text-white hover:opacity-90 transition-all duration-150 active:scale-95"
        >
          <Mail size={12} /> Mail senden
        </a>
        <button aria-label="Adresse kopieren"
          onClick={copy}
          className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded border border-line text-fg-muted hover:bg-surface-2 transition-all duration-150 active:scale-95"
          title="Adresse kopieren"
        >
          {copied ? <Check size={12} className="text-success-fg" /> : <Copy size={12} />}
        </button>
      </div>
    </div>,
    document.body,
  );
}
