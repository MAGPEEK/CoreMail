import { useEffect, useRef, useState } from 'react';

/**
 * Displays a number and triggers a short CSS pop animation
 * when the value changes. tabular-nums prevents layout shift.
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
