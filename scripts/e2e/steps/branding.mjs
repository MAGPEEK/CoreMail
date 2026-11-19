// Step 10b (9.3): branding — admin PUT name + colour, PNG + SVG upload, public GET,
// asset headers (nosniff, sandbox CSP, immutable), hostile SVGs refused (400 SVG_UNSAFE),
// branded index.html on / and /bcp/, RBAC, reset restores the defaults.
import { createHash } from 'node:crypto';
import { check, assert, creds, http, session, makePng } from '../lib.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

const NAME = 'E2E Brand';
// Passes 3:1 on the light (4.51:1) and the dark surface (3.70:1) and differs from the default #0078d4,
// so the PUT below carries exactly one warning (headerColor) and the colour var proves the change.
const COLOR = '#1a73e8';
const LOGO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <!-- e2e favicon -->
  <defs><linearGradient id="g"><stop offset="0" stop-color="${COLOR}"/><stop offset="1" stop-color="#00bcf2"/></linearGradient></defs>
  <rect width="32" height="32" rx="6" fill="url(#g)"/>
  <text x="16" y="22" font-size="16" text-anchor="middle" fill="#fff">E</text>
</svg>`;
const HOSTILE = {
  onload: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><rect width="1" height="1"/></svg>',
  script: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  externalHref: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/sprite.svg#a"/></svg>',
  doctype: '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>',
};

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const A = '/api/v1/admin/branding';
  const upload = (slot, body, type) => http('POST', `${A}/assets/${slot}`, { token: admin, body, headers: { 'Content-Type': type } });
  let startVersion = 0;
  let logoUrl;
  let faviconUrl;
  const png = makePng(240, 80, [10, 91, 211]);

  await check('branding: RBAC — anonymous 401, admin GET 200', async () => {
    const anon = await http('PUT', A, { body: { productName: 'x' } });
    assert(anon.status === 401, `anonymous PUT → ${anon.status}`);
    const r = await http('GET', A, { token: admin });
    assert(r.status === 200 && typeof r.json?.version === 'number', `${r.status} ${r.text.slice(0, 200)}`);
    startVersion = r.json.version;
    return `version ${startVersion}`;
  });

  await check('branding: admin PUT product name + colour (version++, low-contrast header colour → warning)', async () => {
    const r = await http('PUT', A, { token: admin, body: { productName: NAME, primaryColor: COLOR, headerColor: '#ffff00', loginText: 'Welcome to the e2e run' } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.productName === NAME && r.json.primaryColor === COLOR, JSON.stringify(r.json).slice(0, 200));
    assert(r.json.version > startVersion, `version ${r.json.version}`);
    const ex = r.json.explicit ?? {};
    assert(ex.productName === true && ex.primaryColor === true && ex.headerColor === true && typeof r.json.defaults?.productName === 'string',
      `admin fields ${JSON.stringify({ explicit: r.json.explicit, defaults: r.json.defaults })}`);
    const w = r.json.warnings ?? [];
    assert(w.length === 1 && w[0].field === 'headerColor' && /^#[0-9a-f]{6}$/.test(w[0].suggestion), JSON.stringify(w));
    const bad = await http('PUT', A, { token: admin, body: { primaryColor: 'red' } });
    assert(bad.status === 400 && bad.json?.field === 'primaryColor', `invalid colour → ${bad.status} ${bad.text}`);
    return `version ${r.json.version}, warning suggestion ${w[0].suggestion}`;
  });

  await check('branding: upload PNG logo + SVG favicon', async () => {
    const r1 = await upload('logoLight', png, 'image/png');
    assert(r1.status === 200, `PNG ${r1.status} ${r1.text.slice(0, 200)}`);
    logoUrl = r1.json.assets.logoLight;
    assert(logoUrl === `/branding/assets/${sha(png)}.png`, `logo URL ${logoUrl}`);
    const r2 = await upload('favicon', LOGO_SVG, 'image/svg+xml');
    assert(r2.status === 200, `SVG ${r2.status} ${r2.text.slice(0, 200)}`);
    faviconUrl = r2.json.assets.favicon;
    assert(/^\/branding\/assets\/[0-9a-f]{64}\.svg$/.test(faviconUrl ?? ''), `favicon URL ${faviconUrl}`);
    return `${logoUrl}, ${faviconUrl}`;
  });

  await check('branding: public GET /api/v1/branding (no auth) shows name, colour and assets', async () => {
    const r = await http('GET', '/api/v1/branding');
    assert(r.status === 200, `${r.status}`);
    assert(/no-cache/.test(r.headers.get('cache-control') ?? ''), `cache-control ${r.headers.get('cache-control')}`);
    assert(r.json.productName === NAME && r.json.primaryColor === COLOR, JSON.stringify(r.json).slice(0, 200));
    assert(r.json.assets.logoLight === logoUrl && r.json.assets.favicon === faviconUrl, JSON.stringify(r.json.assets));
    assert(r.json.loginText === 'Welcome to the e2e run', r.json.loginText);
    return `version ${r.json.version}`;
  });

  await check('branding: assets served immutable with nosniff + sandbox CSP and the right type', async () => {
    const notes = [];
    for (const [url, type] of [[logoUrl, 'image/png'], [faviconUrl, 'image/svg+xml']]) {
      const r = await http('GET', url, { raw: true });
      const body = Buffer.from(await r.arrayBuffer());
      assert(r.status === 200, `${url} → ${r.status}`);
      assert((r.headers.get('content-type') ?? '').startsWith(type), `${url} content-type ${r.headers.get('content-type')}`);
      assert(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff missing');
      const csp = r.headers.get('content-security-policy') ?? '';
      assert(/default-src 'none'/.test(csp) && /\bsandbox\b/.test(csp), `CSP ${csp}`);
      assert(/immutable/.test(r.headers.get('cache-control') ?? ''), `cache-control ${r.headers.get('cache-control')}`);
      assert(sha(body) === url.split('/').pop().slice(0, 64), `${url}: content hash does not match the name`);
      if (type === 'image/png') assert(body.equals(png), 'PNG not byte-identical');
      else assert(!/<!--/.test(body.toString()), 'SVG not re-serialised (comment kept)');
      notes.push(`${type} ${body.length} B`);
    }
    const missing = await http('GET', `/branding/assets/${'0'.repeat(64)}.png`);
    assert(missing.status === 404, `unknown asset → ${missing.status}`);
    return notes.join(', ');
  });

  await check('branding: hostile SVGs refused with 400 SVG_UNSAFE (onload, script, external href, DOCTYPE)', async () => {
    for (const [name, svg] of Object.entries(HOSTILE)) {
      const r = await upload('logoDark', svg, 'image/svg+xml');
      assert(r.status === 400 && r.json?.code === 'SVG_UNSAFE', `${name} → ${r.status} ${r.text.slice(0, 200)}`);
    }
    const wrongType = await upload('logoLight', LOGO_SVG, 'image/png');
    assert(wrongType.status === 400 && wrongType.json?.code === 'TYPE', `SVG as image/png → ${wrongType.status} ${wrongType.text}`);
    const pub = await http('GET', '/api/v1/branding');
    assert(pub.json.assets.logoDark === null && pub.json.assets.logoLight === logoUrl, 'refused uploads changed the branding');
    return `${Object.keys(HOSTILE).join(', ')} refused`;
  });

  await check('branding: served index.html (/ and /bcp/) carries title, colour var, favicon and JSON', async () => {
    const notes = [];
    for (const path of ['/', '/bcp/']) {
      const r = await http('GET', path);
      assert(r.status === 200, `${path} → ${r.status}`);
      const html = r.text;
      assert(html.includes(`<title>${NAME}</title>`), `${path}: title missing`);
      assert(html.includes('<style id="cm-brand">:root{--brand-primary:26 115 232}</style>'), `${path}: colour var missing`);
      assert(html.includes(`href="${faviconUrl}"`), `${path}: favicon missing`);
      const m = /<script id="cm-branding" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
      assert(m, `${path}: branding JSON missing`);
      const json = JSON.parse(m[1]);
      assert(json.productName === NAME && json.assets.favicon === faviconUrl, `${path}: JSON ${m[1].slice(0, 200)}`);
      assert(m.index < html.indexOf('</head>'), `${path}: JSON not in <head>`);
      assert(/no-store/.test(r.headers.get('cache-control') ?? ''), `${path}: cache-control ${r.headers.get('cache-control')}`);
      notes.push(`${path} v${json.version}`);
    }
    return notes.join(', ');
  });

  await check('branding: reset restores the defaults and removes the assets', async () => {
    const r = await http('POST', `${A}/reset`, { token: admin });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.productName !== NAME && r.json.headerColor === null && r.json.loginText === '', JSON.stringify(r.json).slice(0, 200));
    assert(Object.values(r.json.assets).every((v) => v === null), JSON.stringify(r.json.assets));
    assert(Object.values(r.json.explicit ?? { x: true }).every((v) => v === false), `explicit after reset ${JSON.stringify(r.json.explicit)}`);
    assert(r.json.productName === r.json.defaults?.productName && r.json.primaryColor === r.json.defaults?.primaryColor, 'reset → env defaults');
    const pub = await http('GET', '/api/v1/branding');
    assert(pub.json.productName === r.json.productName && pub.json.version === r.json.version, 'public GET not updated');
    assert(pub.json.explicit === undefined && pub.json.defaults === undefined, 'admin-only fields leaked into the public GET');
    const gone = await http('GET', logoUrl);
    assert(gone.status === 404, `old logo still served (${gone.status})`);
    const page = await http('GET', '/');
    assert(!page.text.includes(`<title>${NAME}</title>`), 'index.html still shows the e2e name');
    return `${r.json.productName} ${r.json.primaryColor} v${r.json.version}`;
  });
}
