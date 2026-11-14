/**
 * Removes Bcc header fields (including folded continuation lines) from the
 * header block of a raw RFC 5322 message. The body is left untouched.
 *
 * RFC 8621 §7.5: the server MUST NOT transmit Bcc to recipients. Drafts keep
 * their Bcc (nodemailer's streamTransport sets keepBcc), so it has to be
 * stripped right before the message leaves the server.
 */
export function stripBccHeader(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  // Split so that every header line keeps its own line ending and `rest`
  // starts with the empty separator line.
  const match = /\r?\n(\r?\n)/.exec(text);
  const headerEnd = match ? match.index + match[0].length - match[1]!.length : text.length;
  const header = text.slice(0, headerEnd);
  const rest = text.slice(headerEnd);

  const kept: string[] = [];
  let skipping = false;
  for (const line of header.split(/(?<=\n)/)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line); // folded continuation of the previous field
      continue;
    }
    skipping = /^bcc[ \t]*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(kept.join('') + rest, 'latin1');
}
