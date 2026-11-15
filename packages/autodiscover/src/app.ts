import express, { type Express } from 'express';
import { handleAutodiscoverV1 } from './v1.js';
import { handleAutodiscoverV2 } from './v2.js';

/** The Autodiscover HTTP routes (server.ts adds the error middleware and listens). */
export function createAutodiscoverApp(): Express {
  const app = express();
  app.use(express.text({ type: 'text/xml' }));
  app.use(express.text({ type: 'application/xml' }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'autodiscover' }));

  // Autodiscover v1 (POX) — Outlook and ActiveSync clients (mobilesync schema)
  app.post('/Autodiscover/Autodiscover.xml', handleAutodiscoverV1);
  app.get('/Autodiscover/Autodiscover.xml', handleAutodiscoverV1);

  // Autodiscover v2 (JSON) — Outlook 2019/365, both documented URL forms:
  //   /autodiscover/autodiscover.json/v1.0/{email}?Protocol=…
  //   /autodiscover/autodiscover.json?Email={email}&Protocol=…
  app.get('/autodiscover/autodiscover.json/v1.0/:email', handleAutodiscoverV2);
  app.get('/autodiscover/autodiscover.json', handleAutodiscoverV2);

  // A request to the bare service root is pointed at the v1 endpoint.
  app.get('/', (_req, res) => {
    res.redirect('/Autodiscover/Autodiscover.xml');
  });
  return app;
}
