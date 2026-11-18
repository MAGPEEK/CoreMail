/**
 * 9.4: small form controls of the settings sections (labelled select, checkbox,
 * section heading). Values are written straight to the roaming preferences.
 */
import type { ReactNode } from 'react';

export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-fg mb-1">{title}</h2>
      <p className="text-sm text-fg-muted">{description}</p>
    </div>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-fg mb-2">{title}</legend>
      {children}
    </fieldset>
  );
}

export function SelectField<T extends string | number>({
  label, value, options, onChange, hint,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm text-fg-muted mb-1">{label}</span>
      <select
        className="input w-full"
        value={String(value)}
        onChange={(e) => {
          const hit = options.find((o) => String(o.value) === e.target.value);
          if (hit) onChange(hit.value);
        }}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
      {hint && <span className="block text-xs text-fg-subtle mt-1">{hint}</span>}
    </label>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-line-strong text-accent-fg focus:ring-accent-fg w-4 h-4"
      />
      <span>
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}
