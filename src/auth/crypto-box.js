import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for Canvas tokens / AI keys at rest (spec §6.3).
 * Ciphertext layout: { c: base64, iv: base64, tag: base64 }.
 */
export function createCryptoBox({ keyHex }) {
  if (!keyHex) {
    throw new Error('AGENTIC_TOKEN_AES_KEY is required (32-byte hex)');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('AGENTIC_TOKEN_AES_KEY must decode to exactly 32 bytes');
  }

  function encrypt(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const c = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
      c: c.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  function decrypt(envelope) {
    if (!envelope?.c || !envelope?.iv || !envelope?.tag) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.c, 'base64')), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}
