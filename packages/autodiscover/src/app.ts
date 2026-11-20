import express, { type Express } from 'express';
import { handleAutodiscoverV1 } from './v1.js';
import { handleAutodiscoverV2 } from './v2.js';
import { handleAutoconfig } from './autoconfig.js';

/** The Autodiscover HTTP routes (server.ts adds the error middleware and listens). */
export function createAutodiscoverApp(): Express {
  const app = express();
  app.use(express.text({ type: 'text/xml' }));
  app.use(express.text({ type: 'application/xml' }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'autodiscover' }));

  // Autodiscover v1 (POX) — desktop clients and ActiveSync clients (mobilesync schema).
  // Paths are matched case-insensitively (Express default): clients use
  // /autodiscover/autodiscover.xml, /Autodiscover/Autodiscover.xml, /AutoDiscover/….
  // Some device clients send the XML without (or with an unusual) Content-Type;
  // the body is read as text whatever the type says (bounded).
  const anyText = express.text({ type: () => true, limit: '64kb' });
  app.post('/Autodiscover/Autodiscover.xml', anyText, handleAutodiscoverV1);
  app.get('/Autodiscover/Autodiscover.xml', handleAutodiscoverV1);

  // Autodiscover v2 (JSON) — newer desktop clients, both documented URL forms:
  //   /autodiscover/autodiscover.json/v1.0/{email}?Protocol=…
  //   /autodiscover/autodiscover.json?Email={email}&Protocol=…
  app.get('/autodiscover/autodiscover.json/v1.0/:email', handleAutodiscoverV2);
  app.get('/autodiscover/autodiscover.json', handleAutodiscoverV2);

  // v8.1: Thunderbird / Mozilla autoconfig (ISPDB config-v1.1.xml), both lookup URLs:
  //   https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=…
  //   https://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=…
  app.get('/.well-known/autoconfig/mail/config-v1.1.xml', handleAutoconfig);
  app.get('/mail/config-v1.1.xml', handleAutoconfig);

  // A request to the bare service root is pointed at the v1 endpoint.
  app.get('/', (_req, res) => {
    res.redirect('/Autodiscover/Autodiscover.xml');
  });
  return app;
}
