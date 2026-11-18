/** "Einfügen → Emoji": a grid of emoji buttons, arrow keys move (one tab stop). */
import { useRef, useState } from 'react';
import { AnchoredPopover } from './AnchoredPopover.js';
import { COMPOSE_EMOJI, EMOJI_COLUMNS, gridMove } from '../../lib/composeFormat.js';
import { useT } from '../../i18n/useT.js';

interface Props {
  anchor: HTMLElement;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPopover({ anchor, onPick, onClose }: Props) {
  const t = useT();
  const [active, setActive] = useState(0);
  const grid = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = gridMove(active, e.key, COMPOSE_EMOJI.length, EMOJI_COLUMNS);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    grid.current?.querySelectorAll<HTMLElement>('button')[next]?.focus();
  };

  return (
    <AnchoredPopover anchor={anchor} label={t('compose_emoji_title')} onClose={onClose} className="p-2">
      <div ref={grid} role="group" aria-label={t('compose_emoji_title')} onKeyDown={onKeyDown}
        className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${EMOJI_COLUMNS}, 2rem)` }}>
        {COMPOSE_EMOJI.map((emoji, i) => (
          <button
            key={emoji}
            type="button"
            tabIndex={i === active ? 0 : -1}
            onFocus={() => setActive(i)}
            onClick={() => onPick(emoji)}
            className="w-8 h-8 rounded text-lg leading-none hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            {emoji}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
