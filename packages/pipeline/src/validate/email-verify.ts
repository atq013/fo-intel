/**
 * Email verification.
 *
 * The brief is explicit that contact cells are the core signal and that a
 * mostly-blank file fails, while a guessed value dressed up as verified is
 * disqualifying. Those pull in opposite directions unless the confidence ladder
 * is strict enough that fighting hard for addresses stays safe.
 *
 *   VERIFIED_PUBLISHED  found published on a source, and the mailbox accepts
 *   VERIFIED_PATTERN    derived from >=2 confirmed same-domain addresses, and accepts
 *   INFERRED            plausible, but the domain accepts everything, so unproven
 *   COULD_NOT_VERIFY    no basis
 *
 * Only the first two are allowed into a customer-facing cell. INFERRED is carried
 * in a separate, clearly labelled column - it is real information and hiding it
 * would waste it, but presenting it as verified would be the disqualifying error.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';

export type EmailStatus = 'verified_published' | 'verified_pattern' | 'inferred' | 'could_not_verify' | 'rejected';

export interface EmailCheck {
  address: string;
  status: EmailStatus;
  method: string;
  mxHost: string | null;
  domainAcceptsAll: boolean;
  checkedAt: string;
}

const mxCache = new Map<string, string | null>();
const catchAllCache = new Map<string, boolean>();

export function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase().trim() ?? '';
}

export async function mxHostFor(domain: string): Promise<string | null> {
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  try {
    const records = await dns.resolveMx(domain);
    const best = records.sort((a, b) => a.priority - b.priority)[0]?.exchange ?? null;
    mxCache.set(domain, best);
    return best;
  } catch {
    mxCache.set(domain, null);
    return null;
  }
}

/**
 * SMTP RCPT probe. Opens a conversation with the mail server and asks whether it
 * would accept mail for an address, without sending any.
 *
 * Many residential ISPs block outbound port 25 entirely, and many hosts refuse
 * probes. Both are treated as "unknown", never as "invalid" - a blocked probe
 * says nothing about the address.
 */
async function smtpAccepts(mxHost: string, address: string, timeoutMs = 8000): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25, timeout: timeoutMs });
    let stage = 0;
    let settled = false;

    const finish = (result: boolean | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.on('data', (buf) => {
      const line = buf.toString();
      const code = Number(line.slice(0, 3));

      if (stage === 0 && code === 220) {
        socket.write('HELO fo-intel.local\r\n');
        stage = 1;
      } else if (stage === 1 && code === 250) {
        socket.write('MAIL FROM:<verify@fo-intel.local>\r\n');
        stage = 2;
      } else if (stage === 2 && code === 250) {
        socket.write(`RCPT TO:<${address}>\r\n`);
        stage = 3;
      } else if (stage === 3) {
        socket.write('QUIT\r\n');
        if (code === 250 || code === 251) finish(true);
        else if (code === 550 || code === 551 || code === 553 || code === 554) finish(false);
        else finish(null);
      } else if (code >= 400) {
        finish(null);
      }
    });

    socket.on('error', () => finish(null));
    socket.on('timeout', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/**
 * A domain that accepts mail for a random address accepts everything, so a
 * positive result on a real address proves nothing there. Detecting this is what
 * keeps pattern-derived addresses from being labelled verified.
 */
export async function domainAcceptsAll(domain: string, mxHost: string): Promise<boolean> {
  if (catchAllCache.has(domain)) return catchAllCache.get(domain)!;
  const random = `zz${Math.random().toString(36).slice(2, 12)}@${domain}`;
  const accepted = await smtpAccepts(mxHost, random);
  const isCatchAll = accepted === true;
  catchAllCache.set(domain, isCatchAll);
  return isCatchAll;
}

export async function verifyEmail(address: string, wasPublished: boolean): Promise<EmailCheck> {
  const now = new Date().toISOString();
  const domain = domainOf(address);

  const base: EmailCheck = {
    address,
    status: 'could_not_verify',
    method: '',
    mxHost: null,
    domainAcceptsAll: false,
    checkedAt: now,
  };

  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) {
    return { ...base, status: 'rejected', method: 'not a syntactically valid address' };
  }

  const mx = await mxHostFor(domain);
  if (!mx) {
    return { ...base, status: 'rejected', method: `${domain} publishes no MX record, so it cannot receive mail` };
  }

  const catchAll = await domainAcceptsAll(domain, mx);
  const accepted = await smtpAccepts(mx, address);

  if (accepted === false) {
    return {
      ...base,
      status: 'rejected',
      method: `mail server ${mx} rejected this recipient`,
      mxHost: mx,
      domainAcceptsAll: catchAll,
    };
  }

  if (catchAll) {
    return {
      ...base,
      status: wasPublished ? 'verified_published' : 'inferred',
      method: wasPublished
        ? `published on a source; ${domain} accepts all recipients so delivery could not be independently confirmed`
        : `pattern-derived; ${domain} accepts all recipients so this could not be confirmed`,
      mxHost: mx,
      domainAcceptsAll: true,
    };
  }

  if (accepted === true) {
    return {
      ...base,
      status: wasPublished ? 'verified_published' : 'verified_pattern',
      method: `mail server ${mx} accepted this recipient${wasPublished ? ', and the address is published on a source' : ''}`,
      mxHost: mx,
      domainAcceptsAll: false,
    };
  }

  // Probe blocked or inconclusive. MX exists, so the domain is real.
  return {
    ...base,
    status: wasPublished ? 'verified_published' : 'inferred',
    method: wasPublished
      ? `published on a source; ${domain} has valid MX but the delivery probe was blocked`
      : `pattern-derived; ${domain} has valid MX but the delivery probe was blocked`,
    mxHost: mx,
    domainAcceptsAll: false,
  };
}

/** True when a status may occupy a customer-facing contact cell. */
export function isCustomerFacing(status: EmailStatus): boolean {
  return status === 'verified_published' || status === 'verified_pattern';
}
