/**
 * BCP → SMTP → Banner preview (pure). Mirrors smtp-server core/session.ts
 * `greetingText()`: the default greeting is "<host> ESMTP CoreMail" (the
 * preview showed "<host> CoreMail ESMTP"), and a custom banner that does not
 * start with a domain gets the host name put in front.
 */

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function smtpGreetingPreview(hostname: string, override: boolean, bannerText: string): string {
  const banner = override ? bannerText.replace(/[\r\n]+/g, ' ').trim() : '';
  if (!banner) return `${hostname} ESMTP CoreMail`;
  const first = banner.split(' ')[0] ?? '';
  return first.includes('.') && DOMAIN_RE.test(first) ? banner : `${hostname} ${banner}`;
}
