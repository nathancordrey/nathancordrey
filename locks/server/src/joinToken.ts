import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifiedJoinToken = {
  roomId: string;
  name: string;
  exp: number;
  jti: string;
};

export function verifyJoinToken(
  token: string,
  secret: string,
  expectedRoomId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerifiedJoinToken | null {
  if (secret.length < 16) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, suppliedSignature] = parts;
  if (encoded.length === 0 || suppliedSignature.length === 0) return null;

  const expectedSignature = createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.v !== 1) return null;
    if (typeof parsed.roomId !== 'string' || parsed.roomId !== expectedRoomId) return null;
    if (typeof parsed.name !== 'string' || parsed.name.length < 1 || parsed.name.length > 16) {
      return null;
    }
    if (typeof parsed.exp !== 'number' || !Number.isInteger(parsed.exp)) return null;
    if (parsed.exp <= nowSeconds) return null;
    // Refuse unusually long-lived tokens even if a compromised caller signs one.
    if (parsed.exp > nowSeconds + 5 * 60) return null;
    if (typeof parsed.jti !== 'string' || parsed.jti.length < 8 || parsed.jti.length > 80) {
      return null;
    }

    return {
      roomId: parsed.roomId,
      name: parsed.name,
      exp: parsed.exp,
      jti: parsed.jti,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
