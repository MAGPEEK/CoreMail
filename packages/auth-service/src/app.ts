import express, { type Express } from 'express';
import { registerAuthenticator, legacyLdapAuthenticator } from '@coremail/storage/auth';
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

  // v6.0.0: the pre-v6 LDAP fallback of this service, now as a step of the
  // shared login service (extension point in @coremail/storage/auth).
  registerAuthenticator(legacyLdapAuthenticator());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'auth-service' }));

  app.use('/auth', authRouter);
  app.use('/auth/mfa', mfaRouter);
  app.use('/auth/app-passwords', appPasswordRouter);
  app.use('/auth/sessions', sessionRouter);

  // v5.6.0: OAuth2/Modern Auth completely removed from the stack.
  // MFA-compatible mail client login via app passwords.

  return app;
}
