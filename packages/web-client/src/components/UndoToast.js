import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import toast from 'react-hot-toast';
/**
 * Zeigt einen Toast mit „Rückgängig"-Button.
 * Der Toast verschwindet nach `duration` ms automatisch.
 */
export function showUndoToast({ message, onUndo, duration = 5000 }) {
    toast.custom((t) => (_jsxs("div", { className: `flex items-center gap-3 px-4 py-2.5 bg-gray-900 text-white rounded-md shadow-lg text-sm ${t.visible ? 'animate-in fade-in slide-in-from-top-2' : 'animate-out fade-out'}`, style: { minWidth: 280 }, children: [_jsx("span", { className: "flex-1", children: message }), _jsx("button", { onClick: () => {
                    void onUndo();
                    toast.dismiss(t.id);
                }, className: "font-semibold text-blue-300 hover:text-blue-200 transition-colors", children: "R\u00FCckg\u00E4ngig" }), _jsx("button", { onClick: () => toast.dismiss(t.id), className: "text-gray-400 hover:text-white", "aria-label": "Schlie\u00DFen", children: "\u00D7" })] })), { duration });
}
