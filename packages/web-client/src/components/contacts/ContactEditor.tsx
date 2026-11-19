/**
 * 9.5: contact form — name parts, company, repeatable typed rows (e-mail,
 * phone, address, web page, chat), dates, categories, notes. Every input has a
 * label; problems are shown next to the field and linked via aria-describedby.
 * Form state and checks: lib/contactForm.ts.
 */
import { useId, useState, type ReactNode } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import {
  addRow, effectiveDisplayName, removeRow, updateRow, validateContactForm, contactPayload,
  EMAIL_TYPES, MAX_ROWS, PHONE_TYPES, PHONE_TYPE_LABEL, PLACE_TYPES, PLACE_TYPE_LABEL,
  type AddressEntry, type ContactForm, type ListField,
} from '../../lib/contactForm.js';
import { CategoryPicker } from '../CategoryPicker.js';

interface Props {
  title: string;
  initial: ContactForm;
  saving: boolean;
  onSave: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}

const LABEL = 'block text-sm font-medium text-fg-muted mb-1';
const SECTION = 'text-xs font-semibold text-fg-subtle uppercase tracking-wider mb-3';

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  return text ? <p id={id} className="mt-1 text-xs text-danger-fg">{text}</p> : null;
}

function TextField({ label, value, onChange, placeholder, error, type = 'text', autoComplete }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; error?: string | undefined;
  type?: string; autoComplete?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      <input
        id={id} type={type} className="input" value={value} placeholder={placeholder} autoComplete={autoComplete ?? 'off'}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldError id={`${id}-err`} text={error} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6" aria-label={title}>
      <h3 className={SECTION}>{title}</h3>
      {children}
    </section>
  );
}

type TypedField = Exclude<ListField, 'addresses'>;
const TYPED: Record<TypedField, { types: readonly string[]; labels: Record<string, string>; noun: string; input: string; placeholder: string }> = {
  emails: { types: EMAIL_TYPES, labels: PLACE_TYPE_LABEL, noun: 'E-Mail-Adresse', input: 'email', placeholder: 'name@firma.de' },
  phones: { types: PHONE_TYPES, labels: PHONE_TYPE_LABEL, noun: 'Telefonnummer', input: 'tel', placeholder: '+49 30 123456' },
  urls: { types: PLACE_TYPES, labels: PLACE_TYPE_LABEL, noun: 'Webseite', input: 'url', placeholder: 'https://…' },
  ims: { types: PLACE_TYPES, labels: PLACE_TYPE_LABEL, noun: 'Chat-Adresse', input: 'text', placeholder: 'xmpp:name@server' },
};

function TypedRows({ field, form, setForm, errors }: {
  field: TypedField; form: ContactForm; setForm: (f: ContactForm) => void; errors: Record<string, string>;
}) {
  const spec = TYPED[field];
  const baseId = useId();
  const rows = form[field];
  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const err = errors[`${field}.${r.key}`];
        const inputId = `${baseId}-${r.key}`;
        return (
          <div key={r.key}>
            <div className="flex gap-2 items-start">
              <select
                aria-label={`Art der ${spec.noun} ${i + 1}`}
                className="input w-36 shrink-0"
                value={r.type}
                onChange={(e) => setForm(updateRow(form, field, r.key, { type: e.target.value }))}
              >
                {spec.types.map((t) => <option key={t} value={t}>{spec.labels[t]}</option>)}
              </select>
              <input
                id={inputId} type={spec.input} className="input flex-1" value={r.value} placeholder={spec.placeholder}
                aria-label={`${spec.noun} ${i + 1} (${spec.labels[r.type]})`} autoComplete="off"
                aria-invalid={err ? true : undefined} aria-describedby={err ? `${inputId}-err` : undefined}
                onChange={(e) => setForm(updateRow(form, field, r.key, { value: e.target.value }))}
              />
              <button
                type="button" className="btn-ghost p-2 shrink-0" aria-label={`${spec.noun} ${i + 1} entfernen`}
                onClick={() => setForm(removeRow(form, field, r.key))}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            <FieldError id={`${inputId}-err`} text={err} />
          </div>
        );
      })}
      {rows.length < MAX_ROWS && (
        <button type="button" className="btn-ghost text-xs flex items-center gap-1" onClick={() => setForm(addRow(form, field))}>
          <Plus size={13} aria-hidden="true" /> {spec.noun} hinzufügen
        </button>
      )}
    </div>
  );
}

const ADDRESS_INPUTS: Array<[keyof Omit<AddressEntry, 'type'>, string, string]> = [
  ['street', 'Straße und Hausnummer', 'col-span-2'],
  ['extended', 'Adresszusatz', 'col-span-2'],
  ['postalCode', 'PLZ', ''],
  ['city', 'Ort', ''],
  ['region', 'Bundesland / Region', ''],
  ['country', 'Land', ''],
  ['poBox', 'Postfach', ''],
];

function AddressRows({ form, setForm }: { form: ContactForm; setForm: (f: ContactForm) => void }) {
  const baseId = useId();
  return (
    <div className="space-y-4">
      {form.addresses.map((a, i) => (
        <fieldset key={a.key} className="border border-line rounded-lg p-3">
          <legend className="px-1 text-sm font-medium text-fg-muted">Adresse {i + 1}</legend>
          <div className="flex gap-2 mb-3">
            <select
              aria-label={`Art der Adresse ${i + 1}`} className="input w-36" value={a.type}
              onChange={(e) => setForm(updateRow(form, 'addresses', a.key, { type: e.target.value }))}
            >
              {PLACE_TYPES.map((t) => <option key={t} value={t}>{PLACE_TYPE_LABEL[t]}</option>)}
            </select>
            <button
              type="button" className="btn-ghost p-2 ml-auto" aria-label={`Adresse ${i + 1} entfernen`}
              onClick={() => setForm(removeRow(form, 'addresses', a.key))}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {ADDRESS_INPUTS.map(([f, label, span]) => (
              <div key={f} className={span}>
                <label htmlFor={`${baseId}-${a.key}-${f}`} className={LABEL}>{label}</label>
                <input
                  id={`${baseId}-${a.key}-${f}`} className="input" value={a[f]} autoComplete="off"
                  onChange={(e) => setForm(updateRow(form, 'addresses', a.key, { [f]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      {form.addresses.length < MAX_ROWS && (
        <button type="button" className="btn-ghost text-xs flex items-center gap-1" onClick={() => setForm(addRow(form, 'addresses'))}>
          <Plus size={13} aria-hidden="true" /> Adresse hinzufügen
        </button>
      )}
    </div>
  );
}

export function ContactEditor({ title, initial, saving, onSave, onCancel }: Props) {
  const [form, setForm] = useState<ContactForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const notesId = useId();
  const set = <K extends keyof ContactForm>(k: K) => (v: ContactForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setName = (k: keyof ContactForm['name']) => (v: string) => setForm((f) => ({ ...f, name: { ...f.name, [k]: v } }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateContactForm(form, initial);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(contactPayload(form));
  };
  const errorCount = Object.keys(errors).length;

  return (
    <form className="max-w-2xl p-6" onSubmit={submit} noValidate aria-label={title}>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <button type="button" aria-label="Bearbeiten abbrechen" onClick={onCancel} className="btn-ghost p-1">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {errorCount > 0 && (
        <p role="alert" className="mb-4 rounded border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          Bitte {errorCount === 1 ? 'das markierte Feld' : `die ${errorCount} markierten Felder`} prüfen.
        </p>
      )}

      <Section title="Name">
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Anrede / Titel" value={form.name.prefix} onChange={setName('prefix')} placeholder="z. B. Dr." />
          <TextField label="Namenszusatz" value={form.name.suffix} onChange={setName('suffix')} placeholder="z. B. MBA" />
          <TextField label="Vorname" value={form.name.given} onChange={setName('given')} autoComplete="off" />
          <TextField label="Weitere Vornamen" value={form.name.middle} onChange={setName('middle')} />
          <div className="col-span-2">
            <TextField label="Nachname" value={form.name.family} onChange={setName('family')} />
          </div>
          <div className="col-span-2">
            <TextField
              label="Anzeigename" value={form.displayName} onChange={set('displayName')} error={errors['displayName']}
              placeholder={effectiveDisplayName({ ...form, displayName: '' }) || 'Vollständiger Name'}
            />
          </div>
          <TextField label="Spitzname" value={form.nickname} onChange={set('nickname')} />
          <TextField label="Speichern unter" value={form.fileAs} onChange={set('fileAs')} placeholder="z. B. Nachname, Vorname" />
        </div>
      </Section>

      <Section title="Firma">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <TextField label="Firma" value={form.company} onChange={set('company')} />
          </div>
          <TextField label="Abteilung" value={form.department} onChange={set('department')} />
          <TextField label="Position" value={form.jobTitle} onChange={set('jobTitle')} />
        </div>
      </Section>

      <Section title="E-Mail">
        <TypedRows field="emails" form={form} setForm={setForm} errors={errors} />
      </Section>
      <Section title="Telefon">
        <TypedRows field="phones" form={form} setForm={setForm} errors={errors} />
      </Section>
      <Section title="Adressen">
        <AddressRows form={form} setForm={setForm} />
      </Section>
      <Section title="Web und Chat">
        <div className="space-y-4">
          <TypedRows field="urls" form={form} setForm={setForm} errors={errors} />
          <TypedRows field="ims" form={form} setForm={setForm} errors={errors} />
        </div>
      </Section>

      <Section title="Daten">
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Geburtstag" value={form.birthday} onChange={set('birthday')} error={errors['birthday']} placeholder="TT.MM.JJJJ oder TT.MM." />
          <TextField label="Jahrestag" value={form.anniversary} onChange={set('anniversary')} error={errors['anniversary']} placeholder="TT.MM.JJJJ oder TT.MM." />
        </div>
      </Section>

      <Section title="Kategorien und Notizen">
        <div className="space-y-3">
          <CategoryPicker value={form.categories} onChange={set('categories')} />
          <div>
            <label htmlFor={notesId} className={LABEL}>Notizen</label>
            <textarea id={notesId} className="input resize-none" rows={4} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
          </div>
        </div>
      </Section>

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Abbrechen</button>
        <button type="submit" disabled={saving} className="btn-primary disabled:opacity-50">Speichern</button>
      </div>
    </form>
  );
}
