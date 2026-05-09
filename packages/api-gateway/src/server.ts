import express from 'express';
import { connectDb } from '@coremail/storage';
import { connectRedis, createLogger } from '@coremail/core';

import { mailRouter } from './routes/mail.js';
import { calendarRouter } from './routes/calendar.js';
import { contactsRouter } from './routes/contacts.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { userRouter } from './routes/user.js';
import { adminMailboxesRouter } from './routes/admin/mailboxes.js';
import { adminDomainsRouter } from './routes/admin/domains.js';
import { adminQueuesRouter } from './routes/admin/queues.js';
import { adminLogsRouter } from './routes/admin/logs.js';
import { requireAuth } from './middleware/auth.js';
import { sseHandler } from './sse.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

app.use(express.json({ limit: '10mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Powered-By', 'CoreMail');
  next();
});

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'api-gateway' }));

// SSE live-events (auth checked inside sseHandler via req.apiUser set by requireAuth)
app.get('/api/v1/events', requireAuth, sseHandler);

// Feature routes
app.use('/api/v1/mail', mailRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/user', userRouter);

// Admin routes
app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
app.use('/api/v1/admin/domains', adminDomainsRouter);
app.use('/api/v1/admin/queues', adminQueuesRouter);
app.use('/api/v1/admin/logs', adminLogsRouter);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await connectDb();
  await connectRedis();
  app.listen(PORT, () => log.info({ port: PORT }, 'API Gateway listening'));
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
