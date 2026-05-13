import express from 'express';
import { connectDatabase } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';

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
import { adminGroupsRouter } from './routes/admin/groups.js';
import { adminResourcesRouter } from './routes/admin/resources.js';
import { adminPublicFoldersRouter } from './routes/admin/public-folders.js';
import { smimeRouter } from './routes/smime.js';
import { publicFoldersRouter } from './routes/public-folders.js';
import { powershellRouter } from './routes/powershell.js';
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

// S/MIME + ActiveSync device management
app.use('/api/v1/smime', smimeRouter);

// Public Folders (user-facing)
app.use('/api/v1/public-folders', publicFoldersRouter);

// PowerShell Remoting stub (Exchange Management Shell compatibility)
app.use(express.text({ type: 'application/soap+xml', limit: '5mb' }));
app.use('/PowerShell', powershellRouter);

// Admin routes
app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
app.use('/api/v1/admin/domains', adminDomainsRouter);
app.use('/api/v1/admin/queues', adminQueuesRouter);
app.use('/api/v1/admin/logs', adminLogsRouter);
app.use('/api/v1/admin/groups', adminGroupsRouter);
app.use('/api/v1/admin/resources', adminResourcesRouter);
app.use('/api/v1/admin/public-folders', adminPublicFoldersRouter);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await connectDatabase();
  getRedisClient(); // initialize connection
  app.listen(PORT, () => log.info({ port: PORT }, 'API Gateway listening'));
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
