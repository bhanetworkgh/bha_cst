import { Logger } from '../config/logger.js';

export interface AudioSynthesisInput {
  text: string;
  voiceId?: string;
  modelId?: string;
  /**
   * Cancellation signal. When the caller abandons the request (for example
   * a voice webhook that has hit its response deadline) the in-flight TTS
   * HTTP request is aborted rather than left running to completion, so it
   * cannot consume quota or complete after the turn was abandoned.
   */
  signal?: AbortSignal;
}

export interface AudioSynthesisResult {
  audioBase64: string;
  mimeType: string;
}

export interface AudioSynthesizer {
  synthesize: (input: AudioSynthesisInput) => Promise<AudioSynthesisResult>;
}

export const DEFAULT_MIME_TYPE = 'audio/mpeg';

export interface ElevenLabsSynthesizerOptions {
  apiKey?: string;
  defaultVoiceId?: string;
  modelId?: string;
  baseURL?: string;
  fetchFn?: typeof fetch;
}

/**
 * Creates an ElevenLabs audio synthesizer adhering to CST fail-closed guidelines.
 * All variables (API key, base URL, model ID, voice ID) are loaded exclusively from env/options.
 * Never falls back to a generic/substitute voice or hardcoded defaults.
 */
export function createElevenLabsAudioSynthesizer(
  options: ElevenLabsSynthesizerOptions = {}
): AudioSynthesizer {
  const env = process.env;
  const apiKey = (options.apiKey || env.ELEVENLABS_API_KEY || '').trim();
  const defaultVoiceId = (options.defaultVoiceId || env.ELEVENLABS_VOICE_ID || env.VFARM_ELEVENLABS_VOICE_ID || '').trim();
  const defaultModelId = (options.modelId || env.ELEVENLABS_MODEL_ID || '').trim();
  const rawBaseURL = (options.baseURL || env.ELEVENLABS_BASE_URL || '').trim();
  const customFetch = options.fetchFn || fetch;

  return {
    synthesize: async ({ text, voiceId, modelId, signal }: AudioSynthesisInput): Promise<AudioSynthesisResult> => {
      // 1. Text validation (fail-closed if empty or whitespace)
      const normalizedText = (text || '').trim();
      if (!normalizedText) {
        throw new Error('Text-to-speech input is empty.');
      }

      // 2. Validate API key presence from env (fail-closed)
      if (!apiKey) {
        Logger.error('ElevenLabs synthesis failed: ELEVENLABS_API_KEY is not configured in env');
        throw new Error('ELEVENLABS_API_KEY is required for audio synthesis.');
      }

      // 3. Validate Base URL from env (fail-closed, no hardcoded URL)
      if (!rawBaseURL) {
        Logger.error('ElevenLabs synthesis failed: ELEVENLABS_BASE_URL is not configured in env');
        throw new Error('ELEVENLABS_BASE_URL is required for audio synthesis.');
      }
      const baseURL = rawBaseURL.replace(/\/+$/, '');

      // 4. Resolve voice ID pointer (must be configured in env/registry, strictly no generic fallback)
      const resolvedVoiceId = (voiceId || defaultVoiceId).trim();
      if (!resolvedVoiceId) {
        Logger.error('ElevenLabs synthesis failed: No voice pointer configured for system');
        throw new Error('No ElevenLabs voice ID was provided or configured.');
      }

      // 5. Resolve Model ID from env (fail-closed, no hardcoded model ID)
      const resolvedModelId = (modelId || defaultModelId).trim();
      if (!resolvedModelId) {
        Logger.error('ElevenLabs synthesis failed: ELEVENLABS_MODEL_ID is not configured in env');
        throw new Error('ELEVENLABS_MODEL_ID is required for audio synthesis.');
      }

      const url = `${baseURL}/text-to-speech/${encodeURIComponent(resolvedVoiceId)}`;

      let response: Response;
      try {
        response = await customFetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            Accept: DEFAULT_MIME_TYPE,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: normalizedText,
            model_id: resolvedModelId,
          }),
          signal,
        });
      } catch (networkErr: any) {
        // An abort is an intentional cancellation, not a provider failure:
        // surface it distinctly so the caller can tell "abandoned" from
        // "broken", and do not log it as an error.
        if (networkErr?.name === 'AbortError' || signal?.aborted) {
          const abortErr: any = new Error('ElevenLabs synthesis was aborted.');
          abortErr.name = 'AbortError';
          abortErr.aborted = true;
          throw abortErr;
        }
        const errMsg = `ElevenLabs network/connectivity failure: ${networkErr.message}`;
        Logger.error(errMsg);
        throw new Error(errMsg);
      }

      if (!response.ok) {
        let message = `ElevenLabs synthesis failed: ${response.status}`;
        try {
          const body = (await response.json()) as { detail?: unknown; message?: unknown };
          const detail =
            typeof body.detail === 'string'
              ? body.detail
              : body.detail && typeof body.detail === 'object' && 'message' in body.detail && typeof (body.detail as { message?: unknown }).message === 'string'
              ? (body.detail as { message: string }).message
              : undefined;
          const responseMessage = typeof body.message === 'string' ? body.message : undefined;
          message = detail || responseMessage || message;
        } catch {
          // Keep default error status if body is not JSON
        }
        Logger.error(`ElevenLabs HTTP error (${response.status}): ${message}`);
        throw new Error(message);
      }

      const arrayBuf = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuf);
      if (audioBuffer.length === 0) {
        throw new Error('ElevenLabs returned an empty audio payload.');
      }

      const mimeType = response.headers.get('content-type')?.split(';', 1)[0] || DEFAULT_MIME_TYPE;

      return {
        audioBase64: audioBuffer.toString('base64'),
        mimeType,
      };
    },
  };
}

export function createElevenLabsAudioSynthesizerFromEnv(env: NodeJS.ProcessEnv = process.env): AudioSynthesizer {
  return createElevenLabsAudioSynthesizer({
    apiKey: env.ELEVENLABS_API_KEY,
    defaultVoiceId: env.ELEVENLABS_VOICE_ID || env.VFARM_ELEVENLABS_VOICE_ID,
    modelId: env.ELEVENLABS_MODEL_ID,
    baseURL: env.ELEVENLABS_BASE_URL,
  });
}
