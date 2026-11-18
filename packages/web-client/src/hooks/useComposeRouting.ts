/**
 * 9.4: compose lives in the mail view. A draft shown while another page is open
 * (Ctrl+N in the calendar, a mail reopened after undo send) switches to Mail;
 * leaving the mail view afterwards is fine — the draft is kept and shown again.
 */
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUiStore } from '../store/ui.js';

export function useComposeRouting(): void {
  const activeKey = useUiStore((s) => s.compose.activeKey);
  const location = useLocation();
  const navigate = useNavigate();
  const previous = useRef(activeKey);
  useEffect(() => {
    const changed = activeKey !== null && activeKey !== previous.current;
    previous.current = activeKey;
    if (changed && !location.pathname.startsWith('/mail')) navigate('/mail');
  }, [activeKey, location.pathname, navigate]);
}
