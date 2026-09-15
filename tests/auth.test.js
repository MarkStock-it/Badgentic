import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';
import { createHandoffVerifier } from '../src/auth/handoff.js';
import { createCryptoBox } from '../src/auth/crypto-box.js';
import { identityHash } from '../src/util/id.js';
import { TEST_CONFIG, testUser, mintHandoffToken } from './helpers.js';

describe('jwt', () => {
  it('round-trips a valid token', () => {
    const token = signJwt({ iss: 'betterclss', aud: 'betterclss-agentic', sub: 'abc', exp: Math.floor(Date.now() / 1000) + 60, iat: Math.floor(Date.now() / 1000) }, TEST_CONFIG.jwtSecret);
    const payload = verifyJwt(token, { secret: TEST_CONFIG.jwtSecret, audience: 'betterclss-agentic', issuer: 'betterclss' });
    expect(payload.sub).toBe('abc');
  });

  it('rejects wrong signature, audience, and expired tokens', () => {
    const token = signJwt({ iss: 'betterclss', aud: 'betterclss-agentic', sub: 'abc', exp: Math.floor(Date.now() / 1000) + 60, iat: Math.floor(Date.now() / 1000) }, TEST_CONFIG.jwtSecret);
    expect(verifyJwt(token, { secret: 'other-secret' })).toBeNull();

    const wrongAud = signJwt({ iss: 'betterclss', aud: 'somewhere-else', sub: 'abc', exp: Math.floor(Date.now() / 1000) + 60, iat: Math.floor(Date.now() / 1000) }, TEST_CONFIG.jwtSecret);
    expect(verifyJwt(wrongAud, { secret: TEST_CONFIG.jwtSecret, audience: 'betterclss-agentic', issuer: 'betterclss' })).toBeNull();

    const expired = signJwt({ iss: 'betterclss', aud: 'betterclss-agentic', sub: 'abc', exp: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 20 }, TEST_CONFIG.jwtSecret);
    expect(verifyJwt(expired, { secret: TEST_CONFIG.jwtSecret, audience: 'betterclss-agentic', issuer: 'betterclss' })).toBeNull();
  });
});

describe('handoff verifier', () => {
  const verifier = createHandoffVerifier({ config: TEST_CONFIG });

  it('accepts a well-formed handoff token', () => {
    const user = testUser();
    const claims = verifier(mintHandoffToken(user));
    expect(claims.sub).toBe(identityHash(user.canvasDomain, user.canvasUserId));
    expect(claims.canvasUserId).toBe(user.canvasUserId);
  });

  it('rejects tokens whose sub does not match the identity hash', () => {
    const user = testUser();
    const token = signJwt(
      {
        iss: TEST_CONFIG.jwtIssuer,
        aud: TEST_CONFIG.jwtAudience,
        sub: 'forged-hash',
        canvasUserId: user.canvasUserId,
        canvasDomain: user.canvasDomain,
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
      },
      TEST_CONFIG.jwtSecret
    );
    expect(() => verifier(token)).toThrow(/identity mismatch/);
  });

  it('rejects tokens signed with the wrong secret', () => {
    const user = testUser();
    const token = mintHandoffToken(user, { secret: 'not-the-secret' });
    expect(() => verifier(token)).toThrow(/Invalid or expired/);
  });
});

describe('crypto box', () => {
  it('encrypts and decrypts round-trip', () => {
    const box = createCryptoBox({ keyHex: TEST_CONFIG.tokenAesKeyHex });
    const envelope = box.encrypt('canvas-secret-token');
    expect(envelope.c).not.toContain('canvas-secret-token');
    expect(box.decrypt(envelope)).toBe('canvas-secret-token');
  });

  it('produces different ciphertexts per call (random iv)', () => {
    const box = createCryptoBox({ keyHex: TEST_CONFIG.tokenAesKeyHex });
    const a = box.encrypt('same');
    const b = box.encrypt('same');
    expect(a.c).not.toBe(b.c);
  });

  it('rejects wrong-size keys', () => {
    expect(() => createCryptoBox({ keyHex: 'aabb' })).toThrow(/32 bytes/);
  });
});
