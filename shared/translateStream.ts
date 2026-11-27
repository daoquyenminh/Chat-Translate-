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
      ? options.text
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
