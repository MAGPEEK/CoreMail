/**
 * Shared frame of the app pages: one header row (title + actions, or the command
 * bar) and the body below, with the spacing tokens of lib/pageShell.ts.
 * 10.1: both float as cards on the canvas (lib/paneLayout.ts); the mail view
 * lays out its own pane cards in the body (`bodyCard={false}`) and puts the
 * ribbon into the header (`ribbon`).
 */
import type { ReactNode } from 'react';
import {
  PAGE_BODY_CLASS, PAGE_HEADER_CLASS, PAGE_RIBBON_HEADER_CLASS, PAGE_SHELL_CLASS, PAGE_TITLE_CLASS, pageBodyCardClass,
} from '../lib/pageShell.js';

interface Props {
  /** Page heading (h1). Visually hidden when the command bar takes the header row. */
  title: string;
  /** Command bar shown in the header row instead of the visible title. */
  commandBar?: ReactNode;
  /** The command bar is the mail ribbon (tab row + panel): the header card keeps no row spacing. */
  ribbon?: boolean;
  /** Actions right of the visible title (search, "new", filters). */
  actions?: ReactNode;
  /** Classes of the body row (e.g. its background). */
  bodyClassName?: string;
  /** The body is one card (default); false = the page draws its own pane cards. */
  bodyCard?: boolean;
  children: ReactNode;
}

export function PageShell({ title, commandBar, ribbon = false, actions, bodyClassName = '', bodyCard = true, children }: Props) {
  const header = ribbon ? PAGE_RIBBON_HEADER_CLASS : `${PAGE_HEADER_CLASS} ${commandBar ? 'px-2' : 'px-4'}`;
  return (
    <div className={PAGE_SHELL_CLASS}>
      <div className={`${header} coremail-no-print`}>
        <h1 className={commandBar ? 'sr-only' : PAGE_TITLE_CLASS}>{title}</h1>
        {commandBar}
        {actions && <div className="flex flex-1 min-w-0 items-center justify-end gap-2">{actions}</div>}
      </div>
      <div className={bodyCard ? pageBodyCardClass(bodyClassName) : `${PAGE_BODY_CLASS} ${bodyClassName}`}>{children}</div>
    </div>
  );
}
