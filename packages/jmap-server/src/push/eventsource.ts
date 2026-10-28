/**
 * EventSource push (RFC 8620 §7.3): GET /jmap/eventsource?types=…&closeafter=…&ping=…
 */
import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { resolveAccounts } from '../accounts.js';
import { accountsOf, buildStateChange, changeBus } from './bus.js';

const log = createLogger('jmap:eventsource');

export async function eventSourceHandler(req: Request, res: Response): Promise<void> {
  const user = req.jmapUser!;
  const accounts = await resolveAccounts(user);
  const mine = accountsOf(accounts);
  const mineIds = new Set(mine.map((a) => a.accountId));

  const typesParam = String(req.query['types'] ?? '*');
  const types = typesParam === '*' || !typesParam ? undefined : new Set(typesParam.split(',').map((t) => t.trim()).filter(Boolean));
  const closeAfterState = String(req.query['closeafter'] ?? 'no') === 'state';
  const pingSec = Math.min(300, Math.max(0, parseInt(String(req.query['ping'] ?? '0'), 10) || 0));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let timer: NodeJS.Timeout | null = null;
  const dirty = new Set<string>();
  const flush = async (): Promise<void> => {
    timer = null;
    const list = mine.filter((a) => dirty.has(a.accountId));
    dirty.clear();
    if (!list.length) return;
    const change = await buildStateChange(list, types);
    if (!Object.keys(change.changed).length) return;
    res.write(`event: state\nid: ${change.pushState}\ndata: ${JSON.stringify(change)}\n\n`);
    if (closeAfterState) cleanup();
  };
  const onChange = (accountId: string): void => {
    if (!mineIds.has(accountId)) return;
    dirty.add(accountId);
    if (!timer) timer = setTimeout(() => void flush().catch((err) => log.warn({ err }, 'flush')), 300);
  };
  changeBus.on('change', onChange);

  const ping = pingSec > 0 ? setInterval(() => res.write(`event: ping\ndata: {"interval":${pingSec}}\n\n`), pingSec * 1000) : null;

  const cleanup = (): void => {
    changeBus.off('change', onChange);
    if (ping) clearInterval(ping);
    if (timer) clearTimeout(timer);
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  log.debug({ userId: user.userId, types: typesParam }, 'EventSource verbunden');
}
