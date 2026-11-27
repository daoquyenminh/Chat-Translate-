import { GoogleGenAI } from '@google/genai';
import { TranslationMode } from './shared/prompts';
import {
  formatGeminiUserError,
  inspectGeminiError,
  openTranslateStreamWithFallback,
} from './shared/translateStream';

interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

interface SecretStoreBinding {
  get(): Promise<string | null>;
}

type SecretOrString = string | SecretStoreBinding;

interface CloudflareEnv {
  GEMINI_API_KEY?: SecretOrString;
  VITE_GEMINI_API_KEY?: SecretOrString;
  API_KEY?: SecretOrString;
  GOOGLE_API_KEY?: SecretOrString;
  GEMINI_MODEL?: string;
  ASSETS: AssetsFetcher;
  [key: string]: unknown;
}

interface TranslateBody {
  text?: string;
  mode?: TranslationMode;
  regenerate?: boolean;
}

function jsonResponse(
  payload: Record<string, unknown>,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cydia-Translate': '1',
      ...extraHeaders,
    },
  });
}

async function resolveApiKey(env: CloudflareEnv): Promise<string> {
  const candidates = [
    env.GEMINI_API_KEY,
    env.VITE_GEMINI_API_KEY,
    env.API_KEY,
    env.GOOGLE_API_KEY,
  ];
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    if (val && typeof val === 'object' && 'get' in val && typeof (val as SecretStoreBinding).get === 'function') {
      try {
        const resolved = await (val as SecretStoreBinding).get();
        if (typeof resolved === 'string' && resolved.trim().length > 0) {
          return resolved.trim();
        }
      } catch {
        // Ignore and check next candidate
      }
    }
  }
  return '';
}

function missingKeyResponse(env: CloudflareEnv): Response {
  const envKeys = Object.keys(env).filter((k) => k !== 'ASSETS');
  const detail =
    envKeys.length > 0
      ? ` (đang có biến: ${envKeys.join(', ')})`
      : ' (hiện chưa có biến runtime nào — lưu ý thêm ở mục Variables and Secrets hoặc Secrets Store)';
  return jsonResponse(
    {
      error: `Chưa tìm thấy GEMINI_API_KEY trên Cloudflare Worker${detail}.`,
    },
    500
  );
}

function createClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function handleTranslate(request: Request, env: CloudflareEnv): Promise<Response> {
  const apiKey = await resolveApiKey(env);
  if (!apiKey) {
    return missingKeyResponse(env);
  }

  let body: TranslateBody;
  try {
    body = (await request.json()) as TranslateBody;
  } catch {
    return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
  }

  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  const mode: TranslationMode = body.mode === 'formal' ? 'formal' : 'chat';

  if (!rawText) {
    return jsonResponse({ error: 'Vui lòng nhập nội dung cần dịch.' }, 400);
  }

  if (rawText.length > 8000) {
    return jsonResponse({ error: 'Đoạn văn bản quá dài (tối đa 8.000 ký tự).' }, 400);
  }

  try {
    const ai = createClient(apiKey);
    const preferredModel = typeof env.GEMINI_MODEL === 'string' ? env.GEMINI_MODEL : undefined;
    const opened = await openTranslateStreamWithFallback(ai, {
      text: rawText,
      mode,
      regenerate: body.regenerate,
      preferredModel,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(opened.firstChunk));
          for await (const piece of opened.rest) {
            controller.enqueue(encoder.encode(piece));
          }
          controller.close();
        } catch (streamErr) {
          controller.error(streamErr);
        }
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Cydia-Translate': '1',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (err) {
    const info = inspectGeminiError(err);
    const mapped = formatGeminiUserError(info, 'cloudflare');
    const extraHeaders = mapped.retryAfterSeconds
      ? { 'Retry-After': String(mapped.retryAfterSeconds) }
      : undefined;
    return jsonResponse({ error: mapped.error }, mapped.status, extraHeaders);
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/translate') {
      return handleTranslate(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
