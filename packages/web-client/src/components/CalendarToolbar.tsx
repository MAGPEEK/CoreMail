import { useState } from 'react';
import {
  Plus, ChevronDown, Calendar as CalDay, Briefcase, CalendarRange, LayoutGrid,
  Columns3, Filter, Share2, Printer,
} from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';

export type CalendarView = 'timeGridDay' | 'timeGridWeek' | 'workWeek' | 'dayGridMonth' | 'split';

interface Props {
  view: CalendarView;
  onChangeView: (v: CalendarView) => void;
  onNewEvent: () => void;
  filterCount?: number;
  onClearFilter?: () => void;
  onPrint?: () => void;
  onShare?: () => void;
}

interface MenuState { x: number; y: number; items: ContextMenuItem[] }

export function CalendarToolbar({
  view, onChangeView, onNewEvent, filterCount = 0, onClearFilter, onPrint, onShare,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="flex flex-col items-center px-2">
      <div className="flex items-end gap-1">{children}</div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">{title}</div>
    </div>
  );

  /** Großer Toolbar-Button (Icon oben, Label unten) — Office-Ribbon-Stil */
  const RibbonBtn = ({
    icon, label, active, onClick, disabled, hasArrow,
  }: {
    icon: React.ReactNode;
    label: string;
    active?: boolean;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    hasArrow?: boolean;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center gap-1 min-w-[64px] px-2 py-1.5 rounded transition-all duration-150 active:scale-95 ${
        active
          ? 'bg-accent/10 text-accent ring-1 ring-accent/30'
          : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
      } disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100`}
    >
      <div className="h-7 flex items-center justify-center">{icon}</div>
      <span className="text-[11px] leading-tight text-center max-w-[80px] flex items-center gap-0.5">
        {label}
        {hasArrow && <ChevronDown size={10} className="opacity-60" />}
      </span>
    </button>
  );

  const handleNewEventMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom,
      items: [
        { label: 'Neuer Termin',       icon: <Plus size={14} />, onClick: onNewEvent },
        { label: 'Neue Besprechung',   icon: <Plus size={14} />, onClick: onNewEvent },
        { label: 'Ganztägiges Ereignis', icon: <Plus size={14} />, onClick: onNewEvent },
      ],
    });
  };

  const handleFilterMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: Math.max(8, r.right - 200),
      y: r.bottom,
      items: [
        { label: 'Alle Ereignisse',  icon: <Filter size={14} />, onClick: onClearFilter ?? (() => {}) },
        { label: 'Nur unbeantwortet', icon: <Filter size={14} />, disabled: true, onClick: () => {} },
        { label: 'Hochpriorisiert',  icon: <Filter size={14} />, disabled: true, onClick: () => {} },
      ],
    });
  };

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 shrink-0">
      <div className="flex items-stretch gap-2 divide-x divide-gray-200 dark:divide-gray-700">

        {/* Section: Neu */}
        <Section title="Neu">
          <RibbonBtn
            icon={<Plus size={20} className="text-accent" />}
            label="Neues Ereignis"
            hasArrow
            onClick={handleNewEventMenu}
          />
        </Section>

        {/* Section: Anordnen */}
        <Section title="Anordnen">
          <RibbonBtn icon={<CalDay size={20} />}        label="Tag"          active={view === 'timeGridDay'}  hasArrow onClick={() => onChangeView('timeGridDay')} />
          <RibbonBtn icon={<Briefcase size={20} />}     label="Arbeitswoche" active={view === 'workWeek'}     onClick={() => onChangeView('workWeek')} />
          <RibbonBtn icon={<Columns3 size={20} />}      label="Woche"        active={view === 'timeGridWeek'} onClick={() => onChangeView('timeGridWeek')} />
          <RibbonBtn icon={<LayoutGrid size={20} />}    label="Monat"        active={view === 'dayGridMonth'} onClick={() => onChangeView('dayGridMonth')} />
          <RibbonBtn icon={<CalendarRange size={20} />} label="Geteilte Ansicht" disabled />
        </Section>

        {/* Section: Filter */}
        <Section title="Filter">
          <RibbonBtn
            icon={<Filter size={20} className={filterCount > 0 ? 'text-accent' : ''} />}
            label={filterCount > 0 ? 'Filter angewendet' : 'Filter'}
            active={filterCount > 0}
            hasArrow
            onClick={handleFilterMenu}
          />
        </Section>

        {/* Section: Teilen */}
        <Section title="Teilen">
          <RibbonBtn icon={<Share2 size={20} />}  label="Kalender teilen" onClick={onShare} />
          <RibbonBtn icon={<Printer size={20} />} label="Drucken"         onClick={onPrint} />
        </Section>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
