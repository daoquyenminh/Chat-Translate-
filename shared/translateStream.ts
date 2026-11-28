import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  CHAT_SYSTEM_INSTRUCTION,
  FORMAL_SYSTEM_INSTRUCTION,
  STUDY_SYSTEM_INSTRUCTION,
  StudyAnalysis,
  TRANSLATE_MODEL,
  TTS_FALLBACK_MODEL,
  TTS_MODEL,
  TTS_VOICES,
  TargetLanguage,
  TranslationMode,
  VI_SYSTEM_INSTRUCTION,
  VoiceGender,
  buildStudyPrompt,
  buildTranslatePrompt,
  buildViTranslatePrompt,
} from './prompts';

export function sanitizeInputText(raw: string): string {
  // Strip null bytes, iOS object replacement chars (\uFFFC), and unpaired UTF-16 surrogates
  const cleaned = raw.replace(/[\u0000\uFFFC]/g, '');
  let result = '';
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < cleaned.length ? cleaned.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += cleaned[i] + cleaned[i + 1];
        i++;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Skip lone low surrogate
    } else {
      result += cleaned[i];
    }
  }
  return result.trim();
}

export interface GeminiErrorInfo {
  status: number;
  message: string;
  isRateLimit: boolean;
  isDailyQuota: boolean;
  isTransient: boolean;
  isNotFound: boolean;
  isAuthError: boolean;
  isLocationUnsupported: boolean;
  retryAfterSeconds: number | null;
}

export function inspectGeminiError(err: unknown): GeminiErrorInfo {
  const obj = err as { status?: number; code?: number; message?: string } | null;
  const rawMessage = typeof obj?.message === 'string' ? obj.message : String(err ?? '');
  const numericStatus =
    typeof obj?.status === 'number'
      ? obj.status
      : typeof obj?.code === 'number'
      ? obj.code
      : 0;

  const isAuthError =
    numericStatus === 403 ||
    rawMessage.includes('API_KEY_INVALID') ||
    rawMessage.includes('PERMISSION_DENIED');

  const isLocationUnsupported =
    /User location is not supported/i.test(rawMessage) ||
    (numericStatus === 400 && /FAILED_PRECONDITION/i.test(rawMessage));

  const isRateLimit =
    numericStatus === 429 ||
    rawMessage.includes('RESOURCE_EXHAUSTED') ||
    /\b429\b/.test(rawMessage);

  const isDailyQuota =
    isRateLimit &&
    (/PerDay|per_day|daily|limit:\s*0\b/i.test(rawMessage) ||
      /GenerateRequestsPerDay/i.test(rawMessage));

  const isNotFound =
    numericStatus === 404 ||
    rawMessage.includes('NOT_FOUND') ||
    /\b404\b/.test(rawMessage);

  const isTransient =
    isRateLimit ||
    numericStatus === 503 ||
    numericStatus === 500 ||
    rawMessage.includes('UNAVAILABLE') ||
    rawMessage.includes('overloaded');

  let retryAfterSeconds: number | null = null;
  const retryMatch =
    rawMessage.match(/retry in\s+(\d+(?:\.\d+)?)s/i) ??
    rawMessage.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryMatch) {
    const parsed = Math.ceil(Number(retryMatch[1]));
    if (Number.isFinite(parsed) && parsed > 0) {
      retryAfterSeconds = parsed;
    }
  }

  return {
    status: numericStatus,
    message: rawMessage,
    isRateLimit,
    isDailyQuota,
    isTransient,
    isNotFound,
    isAuthError,
    isLocationUnsupported,
    retryAfterSeconds,
  };
}

export function formatGeminiUserError(
  info: GeminiErrorInfo,
  envLabel: 'cloudflare' | 'server'
): { status: number; error: string; retryAfterSeconds?: number } {
  if (info.isAuthError) {
    return {
      status: 403,
      error:
        envLabel === 'cloudflare'
          ? 'GEMINI_API_KEY không hợp lệ hoặc bị từ chối (403). Kiểm tra lại key trong Cloudflare Settings.'
          : 'API key không hợp lệ hoặc thiếu quyền truy cập. Kiểm tra lại trong Settings > Secrets.',
    };
  }

  if (info.isLocationUnsupported) {
    return {
      status: 400,
      error:
        'Vùng máy chủ kết nối hiện tại bị Google Gemini hạn chế (400). Hãy thử tắt iCloud Private Relay / VPN hoặc thử lại sau giây lát.',
    };
  }

  if (info.isRateLimit) {
    if (info.isDailyQuota) {
      return {
        status: 429,
        error:
          'API key miễn phí đã hết hạn mức gọi Gemini hôm nay (429). Chờ reset hạn mức hoặc bật billing cho API key trong Google AI Studio.',
      };
    }
    const waitHint =
      info.retryAfterSeconds && info.retryAfterSeconds <= 120
        ? ` Vui lòng đợi khoảng ${info.retryAfterSeconds} giây rồi thử lại.`
        : ' Vui lòng đợi vài giây rồi thử lại.';
    return {
      status: 429,
      error: `Đang vượt giới hạn lượt gọi mỗi phút (429).${waitHint}`,
      retryAfterSeconds: info.retryAfterSeconds ?? undefined,
    };
  }

  if (info.isNotFound) {
    return {
      status: 404,
      error: 'Model dịch không khả dụng với API key hiện tại (404).',
    };
  }

  const suffix = info.status ? ` (${info.status})` : '';
  return {
    status: 502,
    error: `Không thể dịch lúc này. Vui lòng thử lại.${suffix}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenedTranslateStream {
  firstChunk: string;
  rest: AsyncGenerator<string, void, unknown>;
  modelUsed: string;
}

async function openFlashLiteStream(
  ai: GoogleGenAI,
  contents: string,
  systemInstruction: string
): Promise<OpenedTranslateStream> {
  const rawStream = await ai.models.generateContentStream({
    model: TRANSLATE_MODEL,
    contents,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  });

  const iterator = rawStream[Symbol.asyncIterator]();
  let firstChunk = '';

  while (!firstChunk) {
    const step = await iterator.next();
    if (step.done) {
      throw new Error('EMPTY_STREAM_OUTPUT');
    }
    const piece = step.value?.text ?? '';
    if (piece) {
      firstChunk = piece;
    }
  }

  async function* restGenerator(): AsyncGenerator<string, void, unknown> {
    while (true) {
      const step = await iterator.next();
      if (step.done) break;
      const piece = step.value?.text ?? '';
      if (piece) {
        yield piece;
      }
    }
  }

  return {
    firstChunk,
    rest: restGenerator(),
    modelUsed: TRANSLATE_MODEL,
  };
}

export async function openTranslateStreamWithFallback(
  ai: GoogleGenAI,
  options: {
    text: string;
    mode: TranslationMode;
    targetLang?: TargetLanguage;
    regenerate?: boolean;
  }
): Promise<OpenedTranslateStream> {
  const systemInstruction =
    options.targetLang === 'vi'
      ? VI_SYSTEM_INSTRUCTION
      : options.mode === 'formal'
      ? FORMAL_SYSTEM_INSTRUCTION
      : CHAT_SYSTEM_INSTRUCTION;
  const contents =
    options.targetLang === 'vi'
      ? buildViTranslatePrompt(options.text)
      : buildTranslatePrompt(options.text, options.regenerate);

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await openFlashLiteStream(ai, contents, systemInstruction);
    } catch (err: unknown) {
      lastError = err;
      const info = inspectGeminiError(err);

      if (info.isAuthError || info.isLocationUnsupported || info.isDailyQuota) {
        throw err;
      }

      if (attempt === 0 && (info.isRateLimit || info.isTransient)) {
        const retryMs =
          info.retryAfterSeconds !== null && info.retryAfterSeconds * 1000 <= 4000
            ? Math.max(1200, info.retryAfterSeconds * 1000)
            : 1500;
        await sleep(retryMs);
        continue;
      }

      throw err;
    }
  }

  throw lastError ?? new Error('TRANSLATE_FAILED');
}

const STUDY_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    inputType: {
      type: Type.STRING,
      enum: ['english', 'vietnamese', 'mixed'],
    },
    hasMistakes: { type: Type.BOOLEAN },
    originalSegments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          status: { type: Type.STRING, enum: ['normal', 'wrong', 'correct', 'key'] },
        },
        required: ['text', 'status'],
      },
    },
    correctedSentence: { type: Type.STRING },
    correctedSegments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          status: { type: Type.STRING, enum: ['normal', 'wrong', 'correct', 'key'] },
        },
        required: ['text', 'status'],
      },
    },
    mistakes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          wrong: { type: Type.STRING },
          correct: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
        required: ['wrong', 'correct', 'explanation'],
      },
    },
    usageContext: { type: Type.STRING },
    alternatives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          english: { type: Type.STRING },
          vietnamese: { type: Type.STRING },
          tone: { type: Type.STRING },
        },
        required: ['english', 'vietnamese', 'tone'],
      },
    },
    keyTakeaways: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          phrase: { type: Type.STRING },
          meaning: { type: Type.STRING },
          note: { type: Type.STRING },
        },
        required: ['phrase', 'meaning', 'note'],
      },
    },
  },
  required: [
    'inputType',
    'hasMistakes',
    'originalSegments',
    'correctedSentence',
    'correctedSegments',
    'mistakes',
    'usageContext',
    'alternatives',
    'keyTakeaways',
  ],
};

function normalizeStudyAnalysis(
  raw: Partial<StudyAnalysis>,
  fallbackSource: string,
  fallbackTranslated: string
): StudyAnalysis {
  const inputType =
    raw.inputType === 'english' || raw.inputType === 'mixed' || raw.inputType === 'vietnamese'
      ? raw.inputType
      : 'vietnamese';
  const correctedSentence =
    typeof raw.correctedSentence === 'string' && raw.correctedSentence.trim()
      ? raw.correctedSentence.trim()
      : fallbackTranslated;

  const validSegment = (seg: unknown): seg is { text: string; status: 'normal' | 'wrong' | 'correct' | 'key' } => {
    if (!seg || typeof seg !== 'object') return false;
    const obj = seg as { text?: unknown; status?: unknown };
    return (
      typeof obj.text === 'string' &&
      obj.text.length > 0 &&
      (obj.status === 'normal' ||
        obj.status === 'wrong' ||
        obj.status === 'correct' ||
        obj.status === 'key')
    );
  };

  const isCapitalizationOnlyDiff = (a: string, b: string): boolean => {
    const cleanA = a.trim().replace(/[.,!?;:'"()]+$/g, '');
    const cleanB = b.trim().replace(/[.,!?;:'"()]+$/g, '');
    return cleanA.length > 0 && cleanA.toLowerCase() === cleanB.toLowerCase();
  };

  const rawMistakes = Array.isArray(raw.mistakes)
    ? raw.mistakes.filter(
        (m) =>
          m &&
          typeof m.wrong === 'string' &&
          typeof m.correct === 'string' &&
          typeof m.explanation === 'string' &&
          m.explanation.trim().length > 0
      )
    : [];

  const ignoredCaseWords = new Set<string>();
  const mistakes = rawMistakes
    .filter((m) => {
      if (isCapitalizationOnlyDiff(m.wrong, m.correct)) {
        ignoredCaseWords.add(m.wrong.trim().toLowerCase());
        return false;
      }
      return true;
    })
    .slice(0, 8);

  const lowerCorrected = correctedSentence.toLowerCase();
  const lowerSource = fallbackSource.toLowerCase();

  const rawOriginalSegments =
    Array.isArray(raw.originalSegments) && raw.originalSegments.filter(validSegment).length > 0
      ? raw.originalSegments.filter(validSegment)
      : [{ text: fallbackSource, status: 'normal' as const }];

  const originalSegments = rawOriginalSegments.map((seg) => {
    if (seg.status !== 'wrong') return seg;
    const token = seg.text.trim().toLowerCase();
    if (
      ignoredCaseWords.has(token) ||
      (token.length > 0 &&
        !mistakes.some((m) => m.wrong.trim().toLowerCase().includes(token)) &&
        new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowerCorrected))
    ) {
      return { ...seg, status: 'normal' as const };
    }
    return seg;
  });

  const rawCorrectedSegments =
    Array.isArray(raw.correctedSegments) && raw.correctedSegments.filter(validSegment).length > 0
      ? raw.correctedSegments.filter(validSegment)
      : [{ text: correctedSentence, status: 'normal' as const }];

  const correctedSegments = rawCorrectedSegments.map((seg) => {
    if (seg.status !== 'correct') return seg;
    const token = seg.text.trim().toLowerCase();
    if (
      ignoredCaseWords.has(token) ||
      (token.length > 0 &&
        !mistakes.some((m) => m.correct.trim().toLowerCase().includes(token)) &&
        new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowerSource))
    ) {
      return { ...seg, status: 'normal' as const };
    }
    return seg;
  });

  const alternatives = Array.isArray(raw.alternatives)
    ? raw.alternatives
        .filter(
          (a) =>
            a &&
            typeof a.english === 'string' &&
            a.english.trim().length > 0 &&
            typeof a.vietnamese === 'string'
        )
        .slice(0, 5)
    : [];

  const keyTakeaways = Array.isArray(raw.keyTakeaways)
    ? raw.keyTakeaways
        .filter(
          (t) =>
            t &&
            typeof t.phrase === 'string' &&
            t.phrase.trim().length > 0 &&
            typeof t.meaning === 'string'
        )
        .slice(0, 5)
    : [];

  return {
    inputType,
    hasMistakes: mistakes.length > 0,
    originalSegments,
    correctedSentence,
    correctedSegments,
    mistakes,
    usageContext:
      typeof raw.usageContext === 'string' && raw.usageContext.trim()
        ? raw.usageContext.trim()
        : 'Dùng trong giao tiếp tiếng Anh hằng ngày để diễn đạt ý tự nhiên và rõ ràng.',
    alternatives,
    keyTakeaways,
  };
}

export async function generateStudyAnalysis(
  ai: GoogleGenAI,
  options: {
    sourceText: string;
    translatedText: string;
    mode: TranslationMode;
  }
): Promise<StudyAnalysis> {
  const contents = buildStudyPrompt(
    options.sourceText,
    options.translatedText,
    options.mode
  );

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: TRANSLATE_MODEL,
        contents,
        config: {
          systemInstruction: STUDY_SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          responseMimeType: 'application/json',
          responseSchema: STUDY_RESPONSE_SCHEMA,
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        throw new Error('EMPTY_STUDY_OUTPUT');
      }

      const parsed = JSON.parse(rawText) as Partial<StudyAnalysis>;
      return normalizeStudyAnalysis(parsed, options.sourceText, options.translatedText);
    } catch (err: unknown) {
      lastError = err;
      const info = inspectGeminiError(err);

      if (info.isAuthError || info.isLocationUnsupported || info.isDailyQuota) {
        throw err;
      }

      if (attempt === 0 && (info.isRateLimit || info.isTransient)) {
        const retryMs =
          info.retryAfterSeconds !== null && info.retryAfterSeconds * 1000 <= 4000
            ? Math.max(1200, info.retryAfterSeconds * 1000)
            : 1500;
        await sleep(retryMs);
        continue;
      }

      throw err;
    }
  }

  throw lastError ?? new Error('STUDY_FAILED');
}

export interface GeneratedSpeechResult {
  audioBase64: string;
  mimeType: string;
}

const ttsResultCache = new Map<string, GeneratedSpeechResult>();
const ttsModelCooldownUntil = new Map<string, number>();
const TTS_CACHE_MAX_ENTRIES = 60;
const TTS_QUOTA_COOLDOWN_MS = 5 * 60 * 1000;

function getCachedTts(key: string): GeneratedSpeechResult | undefined {
  const hit = ttsResultCache.get(key);
  if (!hit) return undefined;
  ttsResultCache.delete(key);
  ttsResultCache.set(key, hit);
  return hit;
}

function setCachedTts(key: string, value: GeneratedSpeechResult): void {
  if (ttsResultCache.size >= TTS_CACHE_MAX_ENTRIES) {
    const oldest = ttsResultCache.keys().next().value;
    if (oldest) {
      ttsResultCache.delete(oldest);
    }
  }
  ttsResultCache.set(key, value);
}

export async function generateSpeechAudio(
  ai: GoogleGenAI,
  options: {
    text: string;
    mode?: TranslationMode;
    voiceGender?: VoiceGender;
  }
): Promise<GeneratedSpeechResult> {
  const gender: VoiceGender = options.voiceGender === 'male' ? 'male' : 'female';
  const resolvedMode: TranslationMode = options.mode === 'chat' ? 'chat' : 'formal';
  const cacheKey = `${gender}:${resolvedMode}:${options.text.trim().toLowerCase()}`;
  const cached = getCachedTts(cacheKey);
  if (cached) {
    return cached;
  }

  const voiceName = TTS_VOICES[gender];
  const speakerLabel =
    gender === 'male'
      ? 'Natural native American English male speaker'
      : 'Natural native American English female speaker';
  const style =
    resolvedMode === 'chat'
      ? `${speakerLabel}, relaxed, friendly everyday local pronunciation`
      : `${speakerLabel}, clear, warm, articulate local pronunciation`;

  const now = Date.now();
  const modelsToTry = [TTS_MODEL, TTS_FALLBACK_MODEL].filter(
    (model) => (ttsModelCooldownUntil.get(model) ?? 0) <= now
  );

  if (modelsToTry.length === 0) {
    const quotaErr = new Error('RESOURCE_EXHAUSTED: GenerateRequestsPerDay limit exceeded') as Error & {
      status?: number;
    };
    quotaErr.status = 429;
    throw quotaErr;
  }

  let lastError: unknown = null;

  for (const model of modelsToTry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: options.text,
                  speechMetadata: {
                    style,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });

        const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const audioBase64 = inlineData?.data ?? '';
        if (!audioBase64) {
          throw new Error('EMPTY_TTS_OUTPUT');
        }

        const result: GeneratedSpeechResult = {
          audioBase64,
          mimeType: inlineData?.mimeType || 'audio/wav',
        };
        setCachedTts(cacheKey, result);
        return result;
      } catch (err: unknown) {
        lastError = err;
        const info = inspectGeminiError(err);

        if (info.isAuthError || info.isLocationUnsupported) {
          throw err;
        }

        if (info.isDailyQuota) {
          ttsModelCooldownUntil.set(model, Date.now() + TTS_QUOTA_COOLDOWN_MS);
          break;
        }

        if (info.isNotFound) {
          ttsModelCooldownUntil.set(model, Date.now() + TTS_QUOTA_COOLDOWN_MS);
          break;
        }

        if (attempt === 0 && (info.isRateLimit || info.isTransient)) {
          const retryMs =
            info.retryAfterSeconds !== null && info.retryAfterSeconds * 1000 <= 3000
              ? Math.max(1000, info.retryAfterSeconds * 1000)
              : 1200;
          await sleep(retryMs);
          continue;
        }

        break;
      }
    }
  }

  throw lastError ?? new Error('TTS_FAILED');
}
