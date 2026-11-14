import express, { type Express } from 'express';
import { createLogger, installAsyncErrorHandling, errorMiddleware } from '@coremail/core';
import { authRouter } from './router/auth.js';
import { mfaRouter } from './router/mfa.js';
import { appPasswordRouter } from './router/app-passwords.js';
import { sessionRouter } from './router/sessions.js';

const log = createLogger('auth-service:http');

export function createApp(): Express {
  // v6: async handler rejections → error middleware instead of process death
  installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'auth-service' }));

  app.use('/auth', authRouter);
  app.use('/auth/mfa', mfaRouter);
  app.use('/auth/app-passwords', appPasswordRouter);
  app.use('/auth/sessions', sessionRouter);

  // v5.6.0: OAuth2/Modern Auth completely removed from the stack.
  // MFA-compatible mail client login via app passwords.

  // v6: shared error middleware (registered last) — no stack/message leaks
  app.use(errorMiddleware(log));

  return app;
}
