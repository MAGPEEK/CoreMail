import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth.js';
export function useMailEvents() {
    const token = useAuthStore((s) => s.accessToken);
    const qc = useQueryClient();
    useEffect(() => {
        if (!token)
            return;
        const es = new EventSource(`/api/v1/events`, {
        // EventSource doesn't support headers natively; token passed via cookie or query in production
        });
        es.addEventListener('mail:new', () => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['messages'] });
        });
        es.addEventListener('mail:update', () => {
            qc.invalidateQueries({ queryKey: ['messages'] });
        });
        es.onerror = () => {
            // EventSource auto-reconnects on error
        };
        return () => es.close();
    }, [token, qc]);
}
