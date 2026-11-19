/**
 * 10.1: queries and writes of /api/v1/mail/templates (lib/mailTemplates.ts).
 * Writes refresh the list here; other tabs follow through the realtime
 * `settings` event with section `templates` (lib/realtimeEvents.ts).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import {
  TEMPLATES_QUERY_KEY, templateQueryKey, type MailTemplate, type TemplateInput, type TemplateList,
} from '../lib/mailTemplates.js';

export function useTemplateList(enabled = true) {
  return useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: () => api.get<TemplateList>('/mail/templates'),
    enabled,
  });
}

export function useTemplate(id: string | null) {
  return useQuery({
    queryKey: templateQueryKey(id ?? ''),
    queryFn: () => api.get<MailTemplate>(`/mail/templates/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
  });
}

/** Loads one template (cached) — for "Verwenden" / "Einfügen". */
export function useFetchTemplate() {
  const qc = useQueryClient();
  return (id: string) => qc.fetchQuery({
    queryKey: templateQueryKey(id),
    queryFn: () => api.get<MailTemplate>(`/mail/templates/${encodeURIComponent(id)}`),
  });
}

export function useTemplateWrites() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
  const create = useMutation({
    mutationFn: (input: TemplateInput) => api.post<MailTemplate>('/mail/templates', input),
    onSuccess: (t) => { qc.setQueryData(templateQueryKey(t.id), t); void refresh(); },
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: TemplateInput }) => api.put<MailTemplate>(`/mail/templates/${encodeURIComponent(id)}`, input),
    onSuccess: (t) => { qc.setQueryData(templateQueryKey(t.id), t); void refresh(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/mail/templates/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => { qc.removeQueries({ queryKey: templateQueryKey(id) }); void refresh(); },
  });
  return { create, update, remove };
}
