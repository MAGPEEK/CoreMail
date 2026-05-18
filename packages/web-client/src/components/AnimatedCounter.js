import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
/**
 * Zeigt eine Zahl an und triggert eine kurze CSS-Pop-Animation,
 * wenn sich der Wert ändert. tabular-nums verhindert Layout-Shift.
 */
export function AnimatedCounter({ value, className = '', }) {
    const [animKey, setAnimKey] = useState(0);
    const prev = useRef(value);
    useEffect(() => {
        if (prev.current !== value) {
            setAnimKey((k) => k + 1);
            prev.current = value;
        }
    }, [value]);
    return (_jsx("span", { className: `tabular-nums animate-count-pop ${className}`, children: value }, animKey));
}
