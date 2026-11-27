import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  CHAT_SYSTEM_INSTRUCTION,
  FORMAL_SYSTEM_INSTRUCTION,
  TRANSLATE_MODEL,
  TargetLanguage,
  TranslationMode,
  VI_SYSTEM_INSTRUCTION,
  buildTranslatePrompt,
} from './prompts';

export interface ModelCandidate {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export const FALLBACK_TRANSLATE_MODEL = 'gemini-4-hydrogen';

export interface ExternalProviderKeys {
  deepseekApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
}

export function buildModelCandidates(preferredModel?: string): ModelCandidate[] {
  const custom = preferredModel?.trim();

  if (custom === FALLBACK_TRANSLATE_MODEL) {
    return [
      { model: FALLBACK_TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.LOW },
      { model: TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.MINIMAL },
    ];
  }

  if (custom === TRANSLATE_MODEL || !custom) {
    return [
      { model: TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.MINIMAL },
      { model: FALLBACK_TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.LOW },
    ];
  }

  // If user chose DeepSeek / GPT / Claude without external key, prioritize Gemini 4 Flash then Flash Lite
  if (
    custom === 'deepseek-chat' ||
    custom === 'gpt-4o-mini' ||
    custom === 'claude-3-5-haiku-latest'
  ) {
    return [
      { model: FALLBACK_TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.LOW },
      { model: TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.MINIMAL },
    ];
  }

  return [
    { model: custom },
    { model: TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.MINIMAL },
    { model: FALLBACK_TRANSLATE_MODEL, thinkingLevel: ThinkingLevel.LOW },
  ];
}

export function sanitizeInputText(raw: string): string {
  // Strip null bytes, iOS object replacement chars (\uFFFC), and unpaired UTF-16 surrogates
  let cleaned = raw.replace(/[\u0000\uFFFC]/g, '');
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

async function openSingleCandidate(
  ai: GoogleGenAI,
  candidate: ModelCandidate,
  contents: string,
  systemInstruction: string
): Promise<OpenedTranslateStream> {
  const config: {
    systemInstruction: string;
    thinkingConfig?: { thinkingLevel: ThinkingLevel };
  } = { systemInstruction };

  if (candidate.thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: candidate.thinkingLevel };
  }

  const rawStream = await ai.models.generateContentStream({
    model: candidate.model,
    contents,
    config,
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
    modelUsed: candidate.model,
  };
}

async function tryExternalProvider(
  modelId: string,
  contents: string,
  systemInstruction: string,
  keys?: ExternalProviderKeys
): Promise<OpenedTranslateStream | null> {
  if (!keys) return null;

  let endpoint = '';
  let apiKey = '';
  let targetModel = modelId;
  let isAnthropic = false;

  if (modelId === 'deepseek-chat') {
    if (keys.deepseekApiKey) {
      endpoint = 'https://api.deepseek.com/chat/completions';
      apiKey = keys.deepseekApiKey;
      targetModel = 'deepseek-chat';
    } else if (keys.openrouterApiKey) {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = keys.openrouterApiKey;
      targetModel = 'deepseek/deepseek-chat';
    }
  } else if (modelId === 'gpt-4o-mini') {
    if (keys.openaiApiKey) {
      endpoint = 'https://api.openai.com/v1/chat/completions';
      apiKey = keys.openaiApiKey;
      targetModel = 'gpt-4o-mini';
    } else if (keys.openrouterApiKey) {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = keys.openrouterApiKey;
      targetModel = 'openai/gpt-4o-mini';
    }
  } else if (modelId === 'claude-3-5-haiku-latest') {
    if (keys.anthropicApiKey) {
      endpoint = 'https://api.anthropic.com/v1/messages';
      apiKey = keys.anthropicApiKey;
      targetModel = 'claude-3-5-haiku-latest';
      isAnthropic = true;
    } else if (keys.openrouterApiKey) {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = keys.openrouterApiKey;
      targetModel = 'anthropic/claude-3.5-haiku';
    }
  }

  if (!endpoint || !apiKey) return null;

  if (isAnthropic) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: targetModel,
        max_tokens: 1024,
        system: systemInstruction,
        messages: [{ role: 'user', content: contents }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (data.content?.[0]?.text ?? '').trim();
    if (!text) return null;
    async function* emptyRest(): AsyncGenerator<string, void, unknown> {}
    return { firstChunk: text, rest: emptyRest(), modelUsed: targetModel };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: targetModel,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: contents },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  if (!text) return null;

  async function* emptyRest(): AsyncGenerator<string, void, unknown> {}
  return { firstChunk: text, rest: emptyRest(), modelUsed: targetModel };
}

export async function openTranslateStreamWithFallback(
  ai: GoogleGenAI,
  options: {
    text: string;
    mode: TranslationMode;
    targetLang?: TargetLanguage;
    regenerate?: boolean;
    preferredModel?: string;
    externalKeys?: ExternalProviderKeys;
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
      ? options.text
      : buildTranslatePrompt(options.text, options.regenerate);

  const customModel = options.preferredModel?.trim();
  if (
    customModel === 'deepseek-chat' ||
    customModel === 'gpt-4o-mini' ||
    customModel === 'claude-3-5-haiku-latest'
  ) {
    try {
      const externalResult = await tryExternalProvider(
        customModel,
        contents,
        systemInstruction,
        options.externalKeys
      );
      if (externalResult) {
        return externalResult;
      }
    } catch {
      // Fallback to Gemini candidates below
    }
  }

  const candidates = buildModelCandidates(options.preferredModel);

  let lastError: unknown = null;

  for (let round = 0; round < 2; round++) {
    let sawRetryable = false;
    let shortestRetryMs = 1600;

    for (const candidate of candidates) {
      try {
        return await openSingleCandidate(ai, candidate, contents, systemInstruction);
      } catch (err: unknown) {
        lastError = err;
        const info = inspectGeminiError(err);

        if (info.isAuthError) {
          throw err;
        }

        if (info.isRateLimit || info.isTransient || info.isNotFound) {
          if (!info.isDailyQuota && (info.isRateLimit || info.isTransient)) {
            sawRetryable = true;
            if (info.retryAfterSeconds !== null) {
              const suggestedMs = info.retryAfterSeconds * 1000;
              if (suggestedMs <= 4000) {
                shortestRetryMs = Math.max(1200, suggestedMs);
              }
            }
          }
          continue;
        }

        throw err;
      }
    }

    if (round === 0 && sawRetryable) {
      await sleep(shortestRetryMs);
      continue;
    }
    break;
  }

  throw lastError ?? new Error('TRANSLATE_FAILED');
}
