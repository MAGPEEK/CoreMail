import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Tag, Clock, GitBranch, BookOpen, Shield, Github, HardDriveDownload } from 'lucide-react';
import { api } from '../api/client';

const GITHUB_URL       = 'https://github.com/MAGPEEK/CoreMail';
const CHANGELOG_URL    = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
const DOCKERHUB_URL    = 'https://hub.docker.com/r/magpeek/coremail-app';

interface VersionInfo { version: string; bootedAt: string }

interface ChangelogVersion { version: string; date: string; title: string }

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center bg-surface-2 border border-line rounded-lg px-4 py-3 min-w-[120px]">
      <span className="text-xs text-fg-subtle mb-0.5">{label}</span>
      <span className="text-base font-semibold text-fg">{value}</span>
    </div>
  );
}


export function ComplianceInfoPage() {
  // Version and release notes come live from the server (the CHANGELOG.md shipped in the image)
  const { data: versionInfo } = useQuery<VersionInfo>({
    queryKey: ['admin', 'version'],
    queryFn:  () => api.get<VersionInfo>('/admin/dashboard/version'),
    staleTime: 30_000,
  });
  const { data: changelog, isError: changelogError } = useQuery<{ versions: ChangelogVersion[] }>({
    queryKey: ['changelog'],
    queryFn:  () => api.get<{ versions: ChangelogVersion[] }>('/changelog'),
    staleTime: 10 * 60_000,
  });
  const recent = (changelog?.versions ?? []).filter((v) => /^\d+\.\d+\.\d+$/.test(v.version)).slice(0, 3);
  const liveVersion = versionInfo?.version ?? '—';
  const bootedAt    = versionInfo?.bootedAt
    ? new Date(versionInfo.bootedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

  return (
    <div className="p-6 max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Shield size={20} className="text-accent-fg" />
        <h1 className="text-xl font-semibold text-fg">System-Informationen</h1>
      </div>

      {/* Version card */}
      <div className="card p-5 flex items-start gap-5">
        <div className="w-14 h-14 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
          <Tag size={24} className="text-accent-fg" />
        </div>
        <div className="flex-1">
          <p className="text-xs text-fg-subtle uppercase tracking-wide font-medium mb-0.5">Aktuelle Version</p>
          <p className="text-3xl font-bold text-fg">v{liveVersion}</p>
          <p className="text-sm text-fg-subtle mt-0.5">CoreMail — Open-Source Mailserver</p>
        </div>
        <div className="flex gap-3">
          <StatBadge label="Container gestartet" value={bootedAt} />
          <StatBadge label="Lizenz" value="MIT" />
        </div>
      </div>

      {/* Links */}
      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">Ressourcen</p>
        <div className="grid grid-cols-2 gap-3">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-line rounded-lg px-4 py-3 hover:bg-surface-2 transition-colors group"
          >
            <Github size={18} className="text-fg-muted group-hover:text-fg shrink-0" />
            <div>
              <p className="text-sm font-medium text-fg">GitHub Repository</p>
              <p className="text-xs text-fg-subtle">MAGPEEK/CoreMail</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-fg-subtle group-hover:text-fg-muted" />
          </a>
          <a
            href={CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-line rounded-lg px-4 py-3 hover:bg-surface-2 transition-colors group"
          >
            <BookOpen size={18} className="text-fg-muted group-hover:text-fg shrink-0" />
            <div>
              <p className="text-sm font-medium text-fg">Changelog</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-fg-subtle group-hover:text-fg-muted" />
          </a>
          <a
            href={`${GITHUB_URL}/releases`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-line rounded-lg px-4 py-3 hover:bg-surface-2 transition-colors group"
          >
            <GitBranch size={18} className="text-fg-muted group-hover:text-fg shrink-0" />
            <div>
              <p className="text-sm font-medium text-fg">Releases</p>
              <p className="text-xs text-fg-subtle">GitHub Releases</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-fg-subtle group-hover:text-fg-muted" />
          </a>
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-line rounded-lg px-4 py-3 hover:bg-surface-2 transition-colors group"
          >
            <Shield size={18} className="text-fg-muted group-hover:text-fg shrink-0" />
            <div>
              <p className="text-sm font-medium text-fg">Issues &amp; Support</p>
              <p className="text-xs text-fg-subtle">Bugs &amp; Feature Requests</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-fg-subtle group-hover:text-fg-muted" />
          </a>
          <a
            href={DOCKERHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-line rounded-lg px-4 py-3 hover:bg-surface-2 transition-colors group"
          >
            <HardDriveDownload size={18} className="text-fg-muted group-hover:text-fg shrink-0" />
            <div>
              <p className="text-sm font-medium text-fg">Docker Hub</p>
              <p className="text-xs text-fg-subtle">magpeek/coremail-app</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-fg-subtle group-hover:text-fg-muted" />
          </a>
        </div>
      </div>

      {/* Recent changelog */}
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-fg-muted">Letzte Versionen</p>
        <div className="space-y-4">
          {changelogError && <p className="text-sm text-fg-subtle">Release-Notes sind gerade nicht abrufbar.</p>}
          {recent.map((h, i, arr) => (
            <div key={h.version} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                  i === 0 ? 'bg-accent/15 text-accent-fg' : 'bg-surface-2 text-fg-subtle'
                }`}>
                  <Tag size={12} />
                </div>
                {i < arr.length - 1 && <div className="w-px flex-1 bg-surface-3 mt-1" />}
              </div>
              <div className="pb-4">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    i === 0 ? 'bg-accent/10 text-accent-fg' : 'bg-surface-2 text-fg-muted'
                  }`}>
                    v{h.version}
                  </span>
                  <span className="text-xs text-fg-subtle flex items-center gap-1">
                    <Clock size={10} />
                    {h.date}
                  </span>
                </div>
                {h.title && <p className="text-sm font-medium text-fg">{h.title}</p>}
              </div>
            </div>
          ))}
        </div>
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-accent-fg hover:underline"
        >
          Vollständiger Changelog auf GitHub
          <ExternalLink size={11} />
        </a>
      </div>

      {/* Stack */}
      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">Technologie-Stack</p>
        <div className="flex flex-wrap gap-2">
          {[
            'Node.js 22', 'TypeScript 5.5', 'React 19', 'Vite', 'TailwindCSS',
            'Prisma 5', 'PostgreSQL 16', 'Redis 7', 'Rspamd 4.0', 'ClamAV',
            'Docker', 'pnpm Workspaces',
          ].map(t => (
            <span key={t} className="bg-surface-2 text-fg-muted text-xs px-2.5 py-1 rounded-full font-medium">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
