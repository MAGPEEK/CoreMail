// Minimal SMTP sink for the CoreMail e2e stack (no dependencies).
// SMTP on :2525 accepts everything (no TLS, no AUTH); HTTP on :8025:
//   GET    /messages  → [{ id, from, to[], size, receivedAt, raw }]
//   DELETE /messages  → clears the store
import net from 'node:net';
import http from 'node:http';

const messages = [];
let seq = 0;

net.createServer((sock) => {
  let buf = '';
  let inData = false;
  let from = '';
  let to = [];
  let data = [];
  const reply = (s) => sock.write(s + '\r\n');
  reply('220 e2e-sink ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          const raw = data.map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n') + '\r\n';
          messages.push({ id: ++seq, from, to, size: raw.length, receivedAt: new Date().toISOString(), raw });
          console.log(`stored #${seq} from=<${from}> to=${to.join(',')} size=${raw.length}`);
          data = []; from = ''; to = [];
          reply('250 2.0.0 queued');
        } else data.push(line);
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { sock.write('250-e2e-sink\r\n250-8BITMIME\r\n250 SIZE 104857600\r\n'); }
      else if (cmd === 'HELO') reply('250 e2e-sink');
      else if (cmd === 'MAIL') { from = (line.match(/<([^>]*)>/) ?? [])[1] ?? ''; reply('250 2.1.0 ok'); }
      else if (cmd === 'RCPT') { to.push((line.match(/<([^>]*)>/) ?? [])[1] ?? ''); reply('250 2.1.5 ok'); }
      else if (cmd === 'DATA') { inData = true; reply('354 go ahead'); }
      else if (cmd === 'RSET') { from = ''; to = []; reply('250 ok'); }
      else if (cmd === 'NOOP') reply('250 ok');
      else if (cmd === 'QUIT') { reply('221 bye'); sock.end(); }
      else reply('502 5.5.2 not implemented');
    }
  });
  sock.on('error', () => {});
}).listen(2525, () => console.log('SMTP sink on :2525'));

http.createServer((req, res) => {
  if (req.url === '/messages' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(messages));
  } else if (req.url === '/messages' && req.method === 'DELETE') {
    messages.length = 0;
    res.end('{"ok":true}');
  } else { res.statusCode = 404; res.end(); }
}).listen(8025, () => console.log('HTTP on :8025'));
