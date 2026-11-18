/**
 * 9.4: Webmail-Richtlinien — the server level of the webmail policies
 * (modules, attachments, external images). Domains and mailboxes override
 * single values in their edit dialogs (components/WebmailPolicyEditor.tsx).
 */
import { WebmailPolicyEditor } from '../components/WebmailPolicyEditor.js';
import { useT } from '../i18n/useT.js';

export function WebmailPoliciesPage() {
  const t = useT();
  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">{t('nav_webmail_policies')}</h1>
        <p className="text-sm text-fg-muted mt-1">{t('wp_page_intro')}</p>
      </div>
      <div className="bg-surface border border-line rounded p-5">
        <WebmailPolicyEditor path="/admin/webmail-policies" area="servers" />
      </div>
    </div>
  );
}
