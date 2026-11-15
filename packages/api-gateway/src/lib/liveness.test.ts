/**
 * 8.0.0: `/livez` is 200 independent of the object-storage check (Kubernetes liveness),
 * and the Helm chart points liveness/startup at it while readiness stays on `/healthz`
 * (a blocking storage check must not cause a restart loop).
 * Run: node --import tsx --test src/lib/liveness.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { livenessHandler } from './liveness.js';

test('/livez answers 200 without touching the storage status', async () => {
  const app = express();
  app.get('/livez', livenessHandler);
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/livez`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'api-gateway' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    server.close();
  }
});

test('server.ts serves /livez; Helm liveness/startup use /livez, readiness /healthz', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/livez', livenessHandler\)/);
  const values = readFileSync(new URL('../../../../infra/k8s/values.yaml', import.meta.url), 'utf8');
  const probe = (name: string) => values.match(new RegExp(`${name}:\\s*\\n\\s*httpGet: \\{ path: (\\S+), port: http \\}`))?.[1];
  assert.equal(probe('startupProbe'), '/livez');
  assert.equal(probe('livenessProbe'), '/livez');
  assert.equal(probe('readinessProbe'), '/healthz');
});
