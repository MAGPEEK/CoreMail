import express, { type Express } from 'express';
import { registerAuthenticator } from '@coremail/storage/auth';
import { ldapAuthenticator } from '@coremail/auth-ldap';
import { authRouter } from './router/auth.js';
import { mfaRouter } from './router/mfa.js';
import { appPasswordRouter } from './router/app-passwords.js';
import { sessionRouter } from './router/sessions.js';

export function createApp(): Express {
  const app = express();
  // v6.0.0: the api-gateway proxy sets X-Forwarded-For to the real client IP
  // (overwritten, not appended). Only trusted from loopback.
  app.set('trust proxy', 'loopback');
  app.use(express.json());

  // v6.1: the LDAP / AD step of the shared login service (@coremail/auth-ldap).
  registerAuthenticator(ldapAuthenticator());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'auth-service' }));

  app.use('/auth', authRouter);
  app.use('/auth/mfa', mfaRouter);
  app.use('/auth/app-passwords', appPasswordRouter);
  app.use('/auth/sessions', sessionRouter);

  // v5.6.0: OAuth2/Modern Auth completely removed from the stack.
  // MFA-compatible mail client login via app passwords.

  return app;
}
