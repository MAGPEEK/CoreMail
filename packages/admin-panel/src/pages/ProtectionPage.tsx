import { Shield, CheckCircle, XCircle, Info } from 'lucide-react';

interface FeatureRow { label: string; description: string; enabled: boolean }

const FEATURES: FeatureRow[] = [
  { label: 'SPF-Prüfung', description: 'Sender Policy Framework — prüft ob Absender-IP autorisiert ist', enabled: true },
  { label: 'DKIM-Validierung', description: 'DomainKeys Identified Mail — verifiziert kryptografische Signatur', enabled: true },
  { label: 'DMARC-Auswertung', description: 'Domain-based Message Authentication — kombiniert SPF + DKIM', enabled: true },
  { label: 'Greylisting', description: 'Verzögert Erstverbindungen von unbekannten Absendern (5 min)', enabled: true },
  { label: 'DNSBL (Spamhaus ZEN)', description: 'zen.spamhaus.org — SBL+XBL+PBL Blacklisten', enabled: true },
  { label: 'DNSBL (SpamCop)', description: 'bl.spamcop.net', enabled: true },
  { label: 'Reverse-DNS-Prüfung', description: 'PTR-Record der Absender-IP muss existieren', enabled: true },
  { label: 'Anti-Spam (rspamd)', description: 'Maschinell lernendes Spam-Scoring mit Bayes-Filter', enabled: true },
  { label: 'Antivirus (ClamAV)', description: 'Virenscan aller eingehenden Anhänge', enabled: true },
  { label: 'Country-Filtering', description: 'GeoIP-basierte Länderfilterung (nicht konfiguriert)', enabled: false },
  { label: 'Attachment-Filter', description: 'Blockierung gefährlicher Dateitypen (.exe, .vbs, .js)', enabled: true },
  { label: 'ARC-Validierung', description: 'Authenticated Received Chain — für Weiterleitungen', enabled: true },
];

export function ProtectionPage() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Shield size={20} className="text-accent" />
        <h1 className="text-xl font-semibold text-gray-900">Schutzrichtlinien</h1>
      </div>

      <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
        <Info size={15} className="shrink-0 mt-0.5" />
        <p>Schutzeinstellungen werden über die Konfiguration des <code className="bg-blue-100 px-1 rounded">security-filter</code>-Services und rspamd/ClamAV gesteuert. Detailkonfiguration in Phase 5.</p>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Schutzmaßnahme</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Beschreibung</th>
              <th className="text-center px-4 py-2.5 font-medium text-gray-500 text-xs">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {FEATURES.map((f) => (
              <tr key={f.label} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-2.5 font-medium text-gray-800">{f.label}</td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{f.description}</td>
                <td className="px-4 py-2.5 text-center">
                  {f.enabled
                    ? <CheckCircle size={16} className="text-green-500 mx-auto" />
                    : <XCircle size={16} className="text-gray-300 mx-auto" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
