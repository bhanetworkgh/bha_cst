import { describe, it, expect, vi } from 'vitest';
import {
  createElevenLabsAudioSynthesizer,
  DEFAULT_MIME_TYPE,
} from '../../engine/src/audio/synthesis.js';

describe('ElevenLabs Audio Synthesizer Adapter', () => {
  const sampleAudioBuffer = Buffer.from('fake-mp3-audio-bytes-for-testing');
  const sampleBase64 = sampleAudioBuffer.toString('base64');
  const testBaseUrl = 'https://api.elevenlabs.io/v1';
  const testModelId = 'eleven_turbo_v2_5';
  const testVoiceId = 'Hmy97GCI840wuICQesiM';
  const testApiKey = 'test-api-key-12345';

  it('successfully synthesizes text into base64 audio loaded from options/env', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};
    let capturedBody: any = {};

    const mockFetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        arrayBuffer: async () => sampleAudioBuffer,
      } as any;
    });

    const synthesizer = createElevenLabsAudioSynthesizer({
      apiKey: testApiKey,
      defaultVoiceId: testVoiceId,
      modelId: testModelId,
      baseURL: testBaseUrl,
      fetchFn: mockFetch,
    });

    const result = await synthesizer.synthesize({
      text: 'Hello from Jason voice clone.',
    });

    expect(capturedUrl).toBe(`${testBaseUrl}/text-to-speech/${testVoiceId}`);
    expect(capturedHeaders['xi-api-key']).toBe(testApiKey);
    expect(capturedHeaders['Accept']).toBe('audio/mpeg');
    expect(capturedBody.text).toBe('Hello from Jason voice clone.');
    expect(capturedBody.model_id).toBe(testModelId);

    expect(result.audioBase64).toBe(sampleBase64);
    expect(result.mimeType).toBe(DEFAULT_MIME_TYPE);
  });

  it('fails closed when text is empty or whitespace only', async () => {
    const synthesizer = createElevenLabsAudioSynthesizer({
      apiKey: testApiKey,
      defaultVoiceId: testVoiceId,
      modelId: testModelId,
      baseURL: testBaseUrl,
    });

    await expect(synthesizer.synthesize({ text: '   ' })).rejects.toThrow('Text-to-speech input is empty.');
  });

  it('fails closed when ELEVENLABS_API_KEY is missing', async () => {
    const origKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    try {
      const synthesizer = createElevenLabsAudioSynthesizer({
        apiKey: '',
        defaultVoiceId: testVoiceId,
        modelId: testModelId,
        baseURL: testBaseUrl,
      });

      await expect(synthesizer.synthesize({ text: 'Valid message' })).rejects.toThrow(
        'ELEVENLABS_API_KEY is required for audio synthesis.'
      );
    } finally {
      if (origKey) process.env.ELEVENLABS_API_KEY = origKey;
    }
  });

  it('fails closed when ELEVENLABS_BASE_URL is missing', async () => {
    const origUrl = process.env.ELEVENLABS_BASE_URL;
    delete process.env.ELEVENLABS_BASE_URL;

    try {
      const synthesizer = createElevenLabsAudioSynthesizer({
        apiKey: testApiKey,
        defaultVoiceId: testVoiceId,
        modelId: testModelId,
        baseURL: '',
      });

      await expect(synthesizer.synthesize({ text: 'Valid message' })).rejects.toThrow(
        'ELEVENLABS_BASE_URL is required for audio synthesis.'
      );
    } finally {
      if (origUrl) process.env.ELEVENLABS_BASE_URL = origUrl;
    }
  });

  it('fails closed when ELEVENLABS_MODEL_ID is missing', async () => {
    const origModel = process.env.ELEVENLABS_MODEL_ID;
    delete process.env.ELEVENLABS_MODEL_ID;

    try {
      const synthesizer = createElevenLabsAudioSynthesizer({
        apiKey: testApiKey,
        defaultVoiceId: testVoiceId,
        modelId: '',
        baseURL: testBaseUrl,
      });

      await expect(synthesizer.synthesize({ text: 'Valid message' })).rejects.toThrow(
        'ELEVENLABS_MODEL_ID is required for audio synthesis.'
      );
    } finally {
      if (origModel) process.env.ELEVENLABS_MODEL_ID = origModel;
    }
  });

  it('fails closed when no voice ID is provided or configured (no generic fallback)', async () => {
    const origVoice = process.env.ELEVENLABS_VOICE_ID;
    const origVfarmVoice = process.env.VFARM_ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_VOICE_ID;
    delete process.env.VFARM_ELEVENLABS_VOICE_ID;

    try {
      const synthesizer = createElevenLabsAudioSynthesizer({
        apiKey: testApiKey,
        defaultVoiceId: '',
        modelId: testModelId,
        baseURL: testBaseUrl,
      });

      await expect(synthesizer.synthesize({ text: 'Valid message', voiceId: '' })).rejects.toThrow(
        'No ElevenLabs voice ID was provided or configured.'
      );
    } finally {
      if (origVoice) process.env.ELEVENLABS_VOICE_ID = origVoice;
      if (origVfarmVoice) process.env.VFARM_ELEVENLABS_VOICE_ID = origVfarmVoice;
    }
  });

  it('fails closed with descriptive error on upstream ElevenLabs API errors', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: false,
        status: 401,
        json: async () => ({ detail: 'Invalid API key provided' }),
      } as any;
    });

    const synthesizer = createElevenLabsAudioSynthesizer({
      apiKey: 'bad-key',
      defaultVoiceId: testVoiceId,
      modelId: testModelId,
      baseURL: testBaseUrl,
      fetchFn: mockFetch,
    });

    await expect(synthesizer.synthesize({ text: 'Hello' })).rejects.toThrow('Invalid API key provided');
  });

  it('fails closed when ElevenLabs returns an empty audio payload', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        arrayBuffer: async () => Buffer.alloc(0),
      } as any;
    });

    const synthesizer = createElevenLabsAudioSynthesizer({
      apiKey: testApiKey,
      defaultVoiceId: testVoiceId,
      modelId: testModelId,
      baseURL: testBaseUrl,
      fetchFn: mockFetch,
    });

    await expect(synthesizer.synthesize({ text: 'Hello' })).rejects.toThrow(
      'ElevenLabs returned an empty audio payload.'
    );
  });
});
