import { Inbox, Mail, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n/useT.js';

/** Generic shimmer bar */
export function SkeletonBar({ width = '100%', height = 12, className = '' }: { width?: string | number; height?: number; className?: string }) {
  return (
    <span
      className={`block rounded bg-gradient-to-r from-surface-3 via-surface-2 to-surface-3 bg-[length:200%_100%] animate-shimmer ${className}`}
      style={{ width: typeof width === 'number' ? `${width}px` : width, height }}
    />
  );
}

/** Skeleton list for MessageList while loading */
export function MessageListSkeleton({ rows = 8, label }: { rows?: number; label?: string }) {
  return (
    <div className="flex-1 overflow-hidden" {...(label ? { role: 'status', 'aria-busy': true, 'aria-label': label } : { 'aria-hidden': true })}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-3 py-2.5 border-b border-line">
          <div className="flex items-start gap-2.5">
            <span className="w-4 h-4 shrink-0" />
            <span className="w-4 h-4 shrink-0" />
            <span className="w-7 h-7 rounded-full bg-surface-3 shrink-0 animate-shimmer bg-gradient-to-r from-surface-3 via-surface-2 to-surface-3 bg-[length:200%_100%]" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center justify-between">
                <SkeletonBar width={120 + (i % 4) * 30} height={10} />
                <SkeletonBar width={38} height={9} />
              </div>
              <SkeletonBar width={`${60 + (i * 7) % 30}%`} height={9} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton for MessageReader */
export function MessageReaderSkeleton() {
  return (
    <div className="flex-1 flex flex-col bg-surface p-6 space-y-6">
      <div className="flex items-center gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBar key={i} width={i === 4 ? 60 : 90} height={28} className="rounded" />
        ))}
      </div>
      <div className="space-y-3">
        <SkeletonBar width="70%" height={22} />
        <div className="space-y-2">
          <SkeletonBar width="40%" height={11} />
          <SkeletonBar width="55%" height={11} />
          <SkeletonBar width="35%" height={11} />
        </div>
      </div>
      <div className="space-y-2 pt-3">
        <SkeletonBar width="98%" height={12} />
        <SkeletonBar width="92%" height={12} />
        <SkeletonBar width="95%" height={12} />
        <SkeletonBar width="80%" height={12} />
        <SkeletonBar width="60%" height={12} />
      </div>
    </div>
  );
}

/** Empty state with icon + title + subtitle */
export function EmptyState({
  icon,
  title,
  subtitle,
}: { icon: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 select-none">
      <div className="w-20 h-20 rounded-full bg-surface-2 flex items-center justify-center text-fg-subtle mb-4">
        {icon}
      </div>
      <h3 className="text-base font-medium text-fg-muted mb-1">{title}</h3>
      {subtitle && <p className="text-sm text-fg-subtle max-w-xs">{subtitle}</p>}
    </div>
  );
}

/** Inline illustration for an empty folder: an open tray with a check mark (no asset file). */
function CaughtUpIllustration() {
  return (
    <svg width="132" height="104" viewBox="0 0 132 104" fill="none" aria-hidden="true" className="mb-4">
      <ellipse cx="66" cy="94" rx="46" ry="6" className="fill-surface-3" />
      <path d="M22 50 L36 22 H96 L110 50 V82 a6 6 0 0 1 -6 6 H28 a6 6 0 0 1 -6 -6 Z"
        className="fill-surface stroke-line" strokeWidth="2" strokeLinejoin="round" />
      <path d="M22 50 H46 a4 4 0 0 1 4 4 a16 8 0 0 0 32 0 a4 4 0 0 1 4 -4 H110"
        className="stroke-line" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="66" cy="32" r="18" style={{ fill: 'rgb(var(--color-accent, 0 109 119) / 0.12)' }} />
      <path d="M57 32 l6 6 l12 -12" style={{ stroke: 'rgb(var(--color-accent, 0 109 119))' }}
        strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="104" cy="16" r="3" className="fill-warning-fg" />
      <circle cx="24" cy="24" r="2" className="fill-info-fg" />
      <path d="M114 34 l3 0 M115.5 32.5 l0 3" className="stroke-danger-fg" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Empty folder ("You're all caught up"). */
export function EmptyInbox() {
  const t = useT();
  return (
    <div role="status" className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 select-none">
      <CaughtUpIllustration />
      <h3 className="text-base font-medium text-fg-muted mb-1">{t('empty_caught_up')}</h3>
      <p className="text-sm text-fg-subtle max-w-xs">{t('empty_caught_up_sub')}</p>
    </div>
  );
}

/** Quick filter (unread / flagged / attachments) without hits. */
export function EmptyFilter() {
  const t = useT();
  return (
    <EmptyState
      icon={<Inbox size={36} strokeWidth={1.5} />}
      title={t('empty_filter')}
      subtitle={t('empty_filter_sub')}
    />
  );
}

export function EmptyReader() {
  return (
    <EmptyState
      icon={<Mail size={36} strokeWidth={1.5} />}
      title="Nachricht auswählen"
      subtitle="Wählen Sie eine Nachricht aus der Liste, um sie zu lesen."
    />
  );
}

export function EmptySearch() {
  const t = useT();
  return (
    <EmptyState
      icon={<Search size={36} strokeWidth={1.5} />}
      title={t('empty_search')}
      subtitle={t('empty_search_sub')}
    />
  );
}
