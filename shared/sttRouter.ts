import { GoogleGenAI } from '@google/genai';
import {
  ProviderRouteError,
  RouterEnvConfig,
} from './llmRouter';
import {
  formatGeminiUserError,
  inspectGeminiError,
} from './translateStream';

export type SttProviderName = 'groq-whisper' | 'cloudflare-whisper' | 'gemini-transcribe';

export interface SttRouterOptions {
  audioBase64: string;
  mimeType?: string;
}

export interface SttRouterResult {
  text: string;
  provider: SttProviderName;
}

export interface SttRouterConfig extends RouterEnvConfig {
  runGeminiSttViaProxy?: () => Promise<string | null>;
}

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const CF_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
const GEMINI_TRANSCRIBE_MODELS = [
  'gemini-3.5-transcribe',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
] as const;
const STT_TIMEOUT_MS = 22_000;

const ALLOWED_AUDIO_MIMES = new Map<string, { mime: string; ext: string }>([
  ['audio/webm', { mime: 'audio/webm', ext: 'webm' }],
  ['audio/mp4', { mime: 'audio/mp4', ext: 'm4a' }],
  ['audio/x-m4a', { mime: 'audio/mp4', ext: 'm4a' }],
  ['audio/m4a', { mime: 'audio/mp4', ext: 'm4a' }],
  ['audio/ogg', { mime: 'audio/ogg', ext: 'ogg' }],
  ['audio/mpeg', { mime: 'audio/mpeg', ext: 'mp3' }],
  ['audio/mp3', { mime: 'audio/mpeg', ext: 'mp3' }],
  ['audio/wav', { mime: 'audio/wav', ext: 'wav' }],
  ['audio/wave', { mime: 'audio/wav', ext: 'wav' }],
]);

const BILINGUAL_TRANSCRIBE_PROMPT =
  'Transcribe the spoken audio verbatim in the exact language(s) spoken (Vietnamese, English, or mixed Vietnamese and English). Preserve English technical terms and Vietnamese diacritics accurately. Output ONLY the plain transcribed text with no quotes, labels, timestamps, explanations, or translation. If there is only silence or background noise with no speech, return an empty string.';

let groqSttKeyCursor = 0;

export function normalizeAudioMime(raw?: string): { mime: string; ext: string } {
  if (!raw || typeof raw !== 'string') {
    return { mime: 'audio/webm', ext: 'webm' };
  }
  const baseMime = raw.split(';')[0].trim().toLowerCase();
  return ALLOWED_AUDIO_MIMES.get(baseMime) ?? { mime: 'audio/webm', ext: 'webm' };
}

function cleanTranscribedText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createAbortWithTimeout(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function getOrCreateGeminiClient(config: SttRouterConfig, apiKey: string): GoogleGenAI {
  if (config.geminiClients) {
    const existing = config.geminiClients.get(apiKey);
    if (existing) return existing;
    const created = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    config.geminiClients.set(apiKey, created);
    return created;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
}

async function transcribeWithGroqWhisper(
  apiKey: string,
  audioBytes: Uint8Array,
  mime: string,
  ext: string
): Promise<string> {
  const form = new FormData();
  const blob = new Blob([audioBytes.buffer as ArrayBuffer], { type: mime });
  form.append('file', blob, `voice.${ext}`);
  form.append('model', GROQ_STT_MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append(
    'prompt',
    'Tiếng Việt và English song ngữ tự nhiên. Ví dụ: hôm nay tôi cần send email cho team.'
  );

  const timeout = createAbortWithTimeout(STT_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: timeout.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`GROQ_STT_HTTP_${res.status}: ${errBody.slice(0, 180)}`);
    }

    const payload = (await res.json()) as { text?: string };
    return cleanTranscribedText(payload.text ?? '');
  } finally {
    timeout.clear();
  }
}

async function transcribeWithCloudflareWhisper(
  config: SttRouterConfig,
  audioBase64: string
): Promise<string | null> {
  if (config.cfAiBinding) {
    const out = (await config.cfAiBinding.run(CF_STT_MODEL, {
      audio: audioBase64,
    })) as { text?: string; result?: { text?: string } } | null;
    const text = out?.text ?? out?.result?.text ?? '';
    return cleanTranscribedText(text);
  }

  if (config.cfAiRest) {
    const timeout = createAbortWithTimeout(STT_TIMEOUT_MS);
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${config.cfAiRest.accountId}/ai/run/${CF_STT_MODEL}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.cfAiRest.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ audio: audioBase64 }),
        signal: timeout.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`CF_STT_HTTP_${res.status}: ${errBody.slice(0, 180)}`);
      }

      const payload = (await res.json()) as {
        result?: { text?: string };
        text?: string;
      };
      return cleanTranscribedText(payload.result?.text ?? payload.text ?? '');
    } finally {
      timeout.clear();
    }
  }

  return null;
}

export async function transcribeWithGeminiAudio(
  ai: GoogleGenAI,
  audioBase64: string,
  mimeType: string
): Promise<string> {
  let lastErr: unknown = null;

  for (const model of GEMINI_TRANSCRIBE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            { text: BILINGUAL_TRANSCRIBE_PROMPT },
          ],
        },
      });
      return cleanTranscribedText(response.text ?? '');
    } catch (err: unknown) {
      lastErr = err;
      const info = inspectGeminiError(err);
      if (info.isNotFound || info.isTransient) {
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('Không tìm thấy model nhận diện giọng nói khả dụng.');
}

export async function routeSpeechToText(
  options: SttRouterOptions,
  config: SttRouterConfig
): Promise<SttRouterResult> {
  const cleanBase64 = options.audioBase64
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!cleanBase64) {
    throw new ProviderRouteError('Không nhận được dữ liệu âm thanh.', 400);
  }

  const { mime, ext } = normalizeAudioMime(options.mimeType);
  let audioBytes: Uint8Array;
  try {
    audioBytes = base64ToUint8Array(cleanBase64);
  } catch {
    throw new ProviderRouteError('Dữ liệu âm thanh không hợp lệ.', 400);
  }

  if (audioBytes.byteLength < 128) {
    return { text: '', provider: 'groq-whisper' };
  }

  let lastErr: unknown = null;

  // 1. Primary: Groq Whisper Large v3 Turbo (ultra-fast, native bilingual Viet-Eng)
  if (config.groqApiKeys.length > 0) {
    const startIdx = groqSttKeyCursor % config.groqApiKeys.length;
    groqSttKeyCursor = (groqSttKeyCursor + 1) % config.groqApiKeys.length;

    for (let i = 0; i < config.groqApiKeys.length; i++) {
      const apiKey = config.groqApiKeys[(startIdx + i) % config.groqApiKeys.length];
      try {
        const text = await transcribeWithGroqWhisper(apiKey, audioBytes, mime, ext);
        return { text, provider: 'groq-whisper' };
      } catch (err: unknown) {
        lastErr = err;
      }
    }
  }

  // 2. Secondary: Cloudflare Workers AI Whisper Large v3 Turbo
  if (config.cfAiBinding || config.cfAiRest) {
    try {
      const text = await transcribeWithCloudflareWhisper(config, cleanBase64);
      if (text !== null) {
        return { text, provider: 'cloudflare-whisper' };
      }
    } catch (err: unknown) {
      lastErr = err;
    }
  }

  // 3. Fallback: Gemini 3.5 Transcribe (via US-West proxy if configured, else direct)
  if (config.preferGeminiProxy && config.runGeminiSttViaProxy) {
    try {
      const proxiedText = await config.runGeminiSttViaProxy();
      if (proxiedText !== null) {
        return { text: cleanTranscribedText(proxiedText), provider: 'gemini-transcribe' };
      }
    } catch (err: unknown) {
      lastErr = err;
    }
  }

  if (config.geminiApiKeys.length > 0) {
    for (const apiKey of config.geminiApiKeys) {
      try {
        const ai = getOrCreateGeminiClient(config, apiKey);
        const text = await transcribeWithGeminiAudio(ai, cleanBase64, mime);
        return { text, provider: 'gemini-transcribe' };
      } catch (err: unknown) {
        lastErr = err;
      }
    }
  }

  if (config.runGeminiSttViaProxy && !config.preferGeminiProxy) {
    try {
      const proxiedText = await config.runGeminiSttViaProxy();
      if (proxiedText !== null) {
        return { text: cleanTranscribedText(proxiedText), provider: 'gemini-transcribe' };
      }
    } catch (err: unknown) {
      lastErr = err;
    }
  }

  if (lastErr) {
    const mapped = formatGeminiUserError(inspectGeminiError(lastErr), config.envLabel);
    throw new ProviderRouteError(
      mapped.error || 'Không thể nhận diện giọng nói lúc này. Vui lòng thử lại.',
      mapped.status || 502,
      mapped.retryAfterSeconds
    );
  }

  throw new ProviderRouteError(
    'Chưa cấu hình dịch vụ AI nhận diện giọng nói dự phòng.',
    503
  );
}
