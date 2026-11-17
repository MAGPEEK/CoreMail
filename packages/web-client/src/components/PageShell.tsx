/**
 * Shared frame of the app pages: one header row (title + actions, or the command
 * bar) and the body below, with the spacing tokens of lib/pageShell.ts.
 */
import type { ReactNode } from 'react';
import { PAGE_BODY_CLASS, PAGE_HEADER_CLASS, PAGE_SHELL_CLASS, PAGE_TITLE_CLASS } from '../lib/pageShell.js';

interface Props {
  /** Page heading (h1). Visually hidden when the command bar takes the header row. */
  title: string;
  /** Command bar shown in the header row instead of the visible title. */
  commandBar?: ReactNode;
  /** Actions right of the visible title (search, "new", filters). */
  actions?: ReactNode;
  /** Classes of the body row (e.g. its background). */
  bodyClassName?: string;
  children: ReactNode;
}

export function PageShell({ title, commandBar, actions, bodyClassName = '', children }: Props) {
  return (
    <div className={PAGE_SHELL_CLASS}>
      <div className={`${PAGE_HEADER_CLASS} ${commandBar ? 'px-2' : 'px-4'} coremail-no-print`}>
        <h1 className={commandBar ? 'sr-only' : PAGE_TITLE_CLASS}>{title}</h1>
        {commandBar}
        {actions && <div className="flex flex-1 min-w-0 items-center justify-end gap-2">{actions}</div>}
      </div>
      <div className={`${PAGE_BODY_CLASS} ${bodyClassName}`}>{children}</div>
    </div>
  );
}
