import { useEffect, useState } from 'react';
import { layoutModeForWidth, type LayoutMode } from '../lib/layoutMode.js';

/** Current responsive layout (single / two / three panes), updated on resize and rotation. */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => layoutModeForWidth(window.innerWidth));
  useEffect(() => {
    const update = () => setMode(layoutModeForWidth(window.innerWidth));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return mode;
}
