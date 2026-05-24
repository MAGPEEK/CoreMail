import { useEffect, useRef, useState } from 'react';

/**
 * Zeigt eine Zahl an und triggert eine kurze CSS-Pop-Animation,
 * wenn sich der Wert ändert. tabular-nums verhindert Layout-Shift.
 */
export function AnimatedCounter({
  value,
  className = '',
}: { value: number; className?: string }) {
  const [animKey, setAnimKey] = useState(0);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current !== value) {
      setAnimKey((k) => k + 1);
      prev.current = value;
    }
  }, [value]);

  return (
    <span
      key={animKey}
      className={`tabular-nums animate-count-pop ${className}`}
    >
      {value}
    </span>
  );
}
