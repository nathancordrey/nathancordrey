import { createHmac, randomUUID } from 'node:crypto';

export type JoinTokenPayload = {
  v: 1;
  roomId: string;
  name: string;
  exp: number;
  jti: string;
};

export function createJoinToken(
  secret: string,
  roomId: string,
  name: string,
  ttlSeconds: number = 60
): { token: string; expiresAt: number } {
  if (secret.length < 16) {
    throw new Error('JOIN_TOKEN_SECRET must be at least 16 characters');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: JoinTokenPayload = {
    v: 1,
    roomId,
    name,
    exp: expiresAt,
    jti: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return { token: `${encoded}.${signature}`, expiresAt };
}
