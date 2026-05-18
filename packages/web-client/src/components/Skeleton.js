import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Inbox, Mail, Search } from 'lucide-react';
/** Generischer Shimmer-Bar */
export function SkeletonBar({ width = '100%', height = 12, className = '' }) {
    return (_jsx("span", { className: `block rounded bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 bg-[length:200%_100%] animate-shimmer ${className}`, style: { width: typeof width === 'number' ? `${width}px` : width, height } }));
}
/** Skeleton-Liste für MessageList beim Laden */
export function MessageListSkeleton({ rows = 8 }) {
    return (_jsx("div", { className: "flex-1 overflow-hidden", children: Array.from({ length: rows }).map((_, i) => (_jsx("div", { className: "px-3 py-2.5 border-b border-gray-100 dark:border-gray-700", children: _jsxs("div", { className: "flex items-start gap-2.5", children: [_jsx("span", { className: "w-4 h-4 shrink-0" }), _jsx("span", { className: "w-4 h-4 shrink-0" }), _jsx("span", { className: "w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0 animate-shimmer bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-600 dark:to-gray-700 bg-[length:200%_100%]" }), _jsxs("div", { className: "flex-1 min-w-0 space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(SkeletonBar, { width: 120 + (i % 4) * 30, height: 10 }), _jsx(SkeletonBar, { width: 38, height: 9 })] }), _jsx(SkeletonBar, { width: `${60 + (i * 7) % 30}%`, height: 9 })] })] }) }, i))) }));
}
/** Skeleton für MessageReader */
export function MessageReaderSkeleton() {
    return (_jsxs("div", { className: "flex-1 flex flex-col bg-white dark:bg-gray-900 p-6 space-y-6", children: [_jsx("div", { className: "flex items-center gap-1", children: Array.from({ length: 5 }).map((_, i) => (_jsx(SkeletonBar, { width: i === 4 ? 60 : 90, height: 28, className: "rounded" }, i))) }), _jsxs("div", { className: "space-y-3", children: [_jsx(SkeletonBar, { width: "70%", height: 22 }), _jsxs("div", { className: "space-y-2", children: [_jsx(SkeletonBar, { width: "40%", height: 11 }), _jsx(SkeletonBar, { width: "55%", height: 11 }), _jsx(SkeletonBar, { width: "35%", height: 11 })] })] }), _jsxs("div", { className: "space-y-2 pt-3", children: [_jsx(SkeletonBar, { width: "98%", height: 12 }), _jsx(SkeletonBar, { width: "92%", height: 12 }), _jsx(SkeletonBar, { width: "95%", height: 12 }), _jsx(SkeletonBar, { width: "80%", height: 12 }), _jsx(SkeletonBar, { width: "60%", height: 12 })] })] }));
}
/** Empty-State mit Icon + Titel + Untertitel */
export function EmptyState({ icon, title, subtitle, }) {
    return (_jsxs("div", { className: "flex-1 flex flex-col items-center justify-center text-center px-6 py-12 select-none", children: [_jsx("div", { className: "w-20 h-20 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 dark:text-gray-500 mb-4", children: icon }), _jsx("h3", { className: "text-base font-medium text-gray-700 dark:text-gray-200 mb-1", children: title }), subtitle && _jsx("p", { className: "text-sm text-gray-400 dark:text-gray-500 max-w-xs", children: subtitle })] }));
}
export function EmptyInbox() {
    return (_jsx(EmptyState, { icon: _jsx(Inbox, { size: 36, strokeWidth: 1.5 }), title: "Keine Nachrichten", subtitle: "Wenn neue E-Mails eintreffen, erscheinen sie hier." }));
}
export function EmptyReader() {
    return (_jsx(EmptyState, { icon: _jsx(Mail, { size: 36, strokeWidth: 1.5 }), title: "Nachricht ausw\u00E4hlen", subtitle: "W\u00E4hlen Sie eine Nachricht aus der Liste, um sie zu lesen." }));
}
export function EmptySearch() {
    return (_jsx(EmptyState, { icon: _jsx(Search, { size: 36, strokeWidth: 1.5 }), title: "Keine Treffer", subtitle: "Versuche einen anderen Suchbegriff oder einen anderen Filter." }));
}
