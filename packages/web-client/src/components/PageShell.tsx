/**
 * Shared frame of the app pages: one header row (title + actions, or a command
 * bar) and the body below, with the spacing tokens of lib/pageShell.ts.
 * 10.1: both float as cards on the canvas (lib/paneLayout.ts).
 * 10.7: no ribbon any more — the mail, calendar and contacts views have no
 * header row (`header={false}`: the heading stays for screen readers); their
 * commands live in their own cards. They lay out those cards in the body
 * (`bodyCard={false}`).
 */
import type { ReactNode } from 'react';
import {
  PAGE_BODY_CLASS, PAGE_HEADER_CLASS, PAGE_SHELL_CLASS, PAGE_TITLE_CLASS, pageBodyCardClass,
} from '../lib/pageShell.js';

interface Props {
  /** Page heading (h1). Visually hidden when the command bar takes the header row or there is no header row. */
  title: string;
  /** Command bar shown in the header row instead of the visible title. */
  commandBar?: ReactNode;
  /** Actions right of the visible title (search, "new", filters). */
  actions?: ReactNode;
  /** 10.7: false = no header row (the cards of the body carry the commands). */
  header?: boolean;
  /** Classes of the body row (e.g. its background). */
  bodyClassName?: string;
  /** The body is one card (default); false = the page draws its own pane cards. */
  bodyCard?: boolean;
  children: ReactNode;
}

export function PageShell({ title, commandBar, actions, header = true, bodyClassName = '', bodyCard = true, children }: Props) {
  return (
    <div className={PAGE_SHELL_CLASS}>
      {header ? (
        <div className={`${PAGE_HEADER_CLASS} ${commandBar ? 'px-2' : 'px-4'} coremail-no-print`}>
          <h1 className={commandBar ? 'sr-only' : PAGE_TITLE_CLASS}>{title}</h1>
          {commandBar}
          {actions && <div className="flex flex-1 min-w-0 items-center justify-end gap-2">{actions}</div>}
        </div>
      ) : (
        <h1 className="sr-only">{title}</h1>
      )}
      <div className={bodyCard ? pageBodyCardClass(bodyClassName) : `${PAGE_BODY_CLASS} ${bodyClassName}`}>{children}</div>
    </div>
  );
}
