import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';

// 8 Nov 2026: Destiny's first full test call sent a post-call webhook over
// 100kb, which the app refused as "request entity too large", so no call card.
describe('ElevenLabs post-call body size', () => {
  const app = createApp();
  it('accepts a post-call body far larger than 100kb (it is refused later only for a bad signature, not for size)', async () => {
    const big = { type: 'post_call_transcription', data: { transcript: Array.from({ length: 4000 }, (_, i) => ({ role: 'user', message: `line ${i} `.repeat(10) })) } };
    expect(JSON.stringify(big).length).toBeGreaterThan(300_000);
    const res = await request(app).post('/webhooks/elevenlabs/post-call').set('content-type', 'application/json').send(JSON.stringify(big));
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(500);
  });
});
