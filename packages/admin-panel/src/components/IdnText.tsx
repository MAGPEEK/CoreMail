// Shows a domain, address or address pattern: U-label first, the stored A-label as small
// secondary text (and tooltip). A look-alike mix of scripts gets a warning badge and the
// A-label becomes the prominent form (9.5).
import type { DisplayDomain } from '../lib/idn.js';

interface Props {
  display: DisplayDomain;
  /** Class of the primary text. */
  className?: string;
}

export function IdnText({ display, className = 'font-mono text-xs text-fg break-all' }: Props) {
  if (display.state === 'ascii') return <span className={className}>{display.ascii}</span>;

  if (display.state === 'invalid') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className={className}>{display.ascii}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-bg text-warning-fg">Ungültige Kodierung</span>
      </span>
    );
  }

  if (display.mixedScript) {
    return (
      <span className="inline-block">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className={`${className} font-semibold`}>{display.ascii}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-bg text-warning-fg"
            title="Die Unicode-Darstellung mischt Schriftsysteme und kann einer bekannten Domain täuschend ähnlich sehen.">
            Gemischte Schriftzeichen
          </span>
        </span>
        <span className="block text-[10px] text-fg-subtle break-all" title="Unicode-Darstellung">{display.unicode}</span>
      </span>
    );
  }

  return (
    <span className="inline-block" title={display.ascii}>
      <span className={className}>{display.unicode}</span>
      <span className="block text-[10px] text-fg-subtle font-mono break-all">{display.ascii}</span>
    </span>
  );
}
