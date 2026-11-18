import { useEffect, useState } from 'react';
import { subscribeAnnouncements, type Announcement } from '../lib/announce.js';

/** The app's one polite live region (selection, opened folder, focus changes); toasts bring their own. */
export function LiveRegion() {
  const [current, setCurrent] = useState<Announcement | null>(null);
  useEffect(() => subscribeAnnouncements(setCurrent), []);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {/* the seq key remounts the text node, so an identical message is read again */}
      {current && <span key={current.seq}>{current.text}</span>}
    </div>
  );
}
