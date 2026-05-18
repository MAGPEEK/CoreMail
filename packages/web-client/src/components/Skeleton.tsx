import { Inbox, Mail, Search } from 'lucide-react';
import type { ReactNode } from 'react';

/** Generischer Shimmer-Bar */
export function SkeletonBar({ width = '100%', height = 12, className = '' }: { width?: string | number; height?: number; className?: string }) {
  return (
    <span
      className={`block rounded bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 bg-[length:200%_100%] animate-shimmer ${className}`}
      style={{ width: typeof width === 'number' ? `${width}px` : width, height }}
    />
  );
}

/** Skeleton-Liste für MessageList beim Laden */
export function MessageListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex-1 overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-start gap-2.5">
            <span className="w-4 h-4 shrink-0" />
            <span className="w-4 h-4 shrink-0" />
            <span className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0 animate-shimmer bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 bg-[length:200%_100%]" />
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

/** Skeleton für MessageReader */
export function MessageReaderSkeleton() {
  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-gray-900 p-6 space-y-6">
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

/** Empty-State mit Icon + Titel + Untertitel */
export function EmptyState({
  icon,
  title,
  subtitle,
}: { icon: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 select-none">
      <div className="w-20 h-20 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 dark:text-gray-500 mb-4">
        {icon}
      </div>
      <h3 className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">{title}</h3>
      {subtitle && <p className="text-sm text-gray-400 dark:text-gray-500 max-w-xs">{subtitle}</p>}
    </div>
  );
}

export function EmptyInbox() {
  return (
    <EmptyState
      icon={<Inbox size={36} strokeWidth={1.5} />}
      title="Keine Nachrichten"
      subtitle="Wenn neue E-Mails eintreffen, erscheinen sie hier."
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
  return (
    <EmptyState
      icon={<Search size={36} strokeWidth={1.5} />}
      title="Keine Treffer"
      subtitle="Versuche einen anderen Suchbegriff oder einen anderen Filter."
    />
  );
}
