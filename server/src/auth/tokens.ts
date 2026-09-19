import crypto from 'node:crypto';

/**
 * Host session tokens, held in memory alongside the live sessions they are
 * used to drive. A token is a random 32-byte secret — never the host's id,
 * which is guessable from any event row and was previously handed out as the
 * login token.
 */
interface TokenRecord {
  hostId: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // a long event night, not a work week

const tokens = new Map<string, TokenRecord>();

export function issueHostToken(hostId: string): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokens.set(token, { hostId, expiresAt });
  return { token, expiresAt };
}

/** Returns the host id for a valid, unexpired token, else null. */
export function resolveHostToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const rec = tokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return rec.hostId;
}

export function revokeHostToken(token: string) {
  tokens.delete(token);
}

/** Pulls the bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
