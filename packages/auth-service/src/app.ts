import express from 'express';
import { authRouter } from './router/auth.js';
import { mfaRouter } from './router/mfa.js';
import { appPasswordRouter } from './router/app-passwords.js';
import { sessionRouter } from './router/sessions.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'auth-service' }));

  app.use('/auth', authRouter);
  app.use('/auth/mfa', mfaRouter);
  app.use('/auth/app-passwords', appPasswordRouter);
  app.use('/auth/sessions', sessionRouter);

  return app;
}
