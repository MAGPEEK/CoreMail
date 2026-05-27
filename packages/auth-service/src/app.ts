import express, { type Express } from 'express';
import { authRouter } from './router/auth.js';
import { mfaRouter } from './router/mfa.js';
import { appPasswordRouter } from './router/app-passwords.js';
import { sessionRouter } from './router/sessions.js';
import { oauth2Router } from './oauth2/router.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  // v5.3.3: urlencoded für /oauth2/ls Form-Post (ADFS-Login-Page)
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'auth-service' }));

  app.use('/auth', authRouter);
  app.use('/auth/mfa', mfaRouter);
  app.use('/auth/app-passwords', appPasswordRouter);
  app.use('/auth/sessions', sessionRouter);

  // Phase 10: OAuth2 / Modern Auth for Outlook
  app.use('/oauth2', oauth2Router);

  return app;
}
