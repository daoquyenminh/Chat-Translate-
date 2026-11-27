import { GoogleGenAI } from '@google/genai';
import { TargetLanguage, TranslationMode } from './shared/prompts';
import {
  formatGeminiUserError,
  inspectGeminiError,
  openTranslateStreamWithFallback,
  sanitizeInputText,
} from './shared/translateStream';

interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

interface SecretStoreBinding {
  get(): Promise<string | null>;
}

type SecretOrString = string | SecretStoreBinding;

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): DurableObjectStubLike;
}

interface CloudflareRequest extends Request {
  cf?: {
    colo?: string;
    country?: string;
  };
}

interface CloudflareEnv {
  GEMINI_API_KEY?: SecretOrString;
  VITE_GEMINI_API_KEY?: SecretOrString;
  API_KEY?: SecretOrString;
  GOOGLE_API_KEY?: SecretOrString;
  DEEPSEEK_API_KEY?: SecretOrString;
  OPENAI_API_KEY?: SecretOrString;
  ANTHROPIC_API_KEY?: SecretOrString;
  OPENROUTER_API_KEY?: SecretOrString;
  GEMINI_MODEL?: string;
  GEMINI_PROXY?: DurableObjectNamespaceLike;
  ASSETS: AssetsFetcher;
  [key: string]: unknown;
}

interface TranslateBody {
  text?: string;
  mode?: TranslationMode;
  targetLang?: TargetLanguage;
  model?: string;
  regenerate?: boolean;
}

interface NormalizedTranslatePayload {
  text: string;
  mode: TranslationMode;
  targetLang: TargetLanguage;
  model?: string;
  regenerate?: boolean;
}

// Cloudflare edge PoPs where Google Gemini API returns HTTP 400 (User location is not supported)
const RESTRICTED_COLOS = new Set([
  'HKG',
  'MFM',
  'PEK',
  'PVG',
  'SHA',
  'CAN',
  'SZX',
  'CTU',
  'CKG',
  'DLC',
  'FOC',
  'HGH',
  'HFE',
  'KMG',
  'NKG',
  'NNG',
  'TAO',
  'TSN',
  'WUH',
  'XIY',
  'XMN',
  'CGO',
  'CSX',
  'DME',
  'LED',
  'KJA',
  'SVX',
  'MSQ',
]);

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

async function resolveSingleSecret(val?: SecretOrString): Promise<string> {
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
      // Ignore
    }
  }
  return '';
}

async function resolveApiKey(env: CloudflareEnv): Promise<string> {
  const candidates = [
    env.GEMINI_API_KEY,
    env.VITE_GEMINI_API_KEY,
    env.API_KEY,
    env.GOOGLE_API_KEY,
  ];
  for (const val of candidates) {
    const resolved = await resolveSingleSecret(val);
    if (resolved) return resolved;
  }
  return '';
}

function missingKeyResponse(env: CloudflareEnv): Response {
  const envKeys = Object.keys(env).filter((k) => k !== 'ASSETS' && k !== 'GEMINI_PROXY');
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

let cachedWorkerKey = '';
let cachedWorkerClient: GoogleGenAI | null = null;

function getOrCreateClient(apiKey: string): GoogleGenAI {
  if (!cachedWorkerClient || cachedWorkerKey !== apiKey) {
    cachedWorkerKey = apiKey;
    cachedWorkerClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedWorkerClient;
}

const EXTERNAL_MODEL_IDS = new Set([
  'deepseek-chat',
  'gpt-4o-mini',
  'claude-3-5-haiku-latest',
]);

async function forwardToUsProxy(
  env: CloudflareEnv,
  payload: NormalizedTranslatePayload
): Promise<Response | null> {
  if (!env.GEMINI_PROXY) return null;
  const id = env.GEMINI_PROXY.idFromName('gemini-us-west-v1');
  const stub = env.GEMINI_PROXY.get(id, { locationHint: 'wnam' });
  const proxyReq = new Request('https://gemini-proxy.internal/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return stub.fetch(proxyReq);
}

async function runGeminiTranslation(
  payload: NormalizedTranslatePayload,
  env: CloudflareEnv,
  allowProxyFallback: boolean
): Promise<Response> {
  const apiKey = await resolveApiKey(env);
  if (!apiKey) {
    return missingKeyResponse(env);
  }

  try {
    const ai = getOrCreateClient(apiKey);
    const preferredModel =
      typeof payload.model === 'string' && payload.model.trim()
        ? payload.model.trim()
        : typeof env.GEMINI_MODEL === 'string'
        ? env.GEMINI_MODEL
        : undefined;

    let externalKeys:
      | {
          deepseekApiKey?: string;
          openaiApiKey?: string;
          anthropicApiKey?: string;
          openrouterApiKey?: string;
        }
      | undefined;

    if (preferredModel && EXTERNAL_MODEL_IDS.has(preferredModel)) {
      const [providerKey, openrouterKey] = await Promise.all([
        preferredModel === 'deepseek-chat'
          ? resolveSingleSecret(env.DEEPSEEK_API_KEY)
          : preferredModel === 'gpt-4o-mini'
          ? resolveSingleSecret(env.OPENAI_API_KEY)
          : resolveSingleSecret(env.ANTHROPIC_API_KEY),
        resolveSingleSecret(env.OPENROUTER_API_KEY),
      ]);
      externalKeys = {
        deepseekApiKey: preferredModel === 'deepseek-chat' ? providerKey || undefined : undefined,
        openaiApiKey: preferredModel === 'gpt-4o-mini' ? providerKey || undefined : undefined,
        anthropicApiKey:
          preferredModel === 'claude-3-5-haiku-latest' ? providerKey || undefined : undefined,
        openrouterApiKey: openrouterKey || undefined,
      };
    }

    const opened = await openTranslateStreamWithFallback(ai, {
      text: payload.text,
      mode: payload.mode,
      targetLang: payload.targetLang,
      regenerate: payload.regenerate,
      preferredModel,
      externalKeys,
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

    if (allowProxyFallback && info.isLocationUnsupported && env.GEMINI_PROXY) {
      const proxied = await forwardToUsProxy(env, payload);
      if (proxied) {
        return proxied;
      }
    }

    const mapped = formatGeminiUserError(info, 'cloudflare');
    const extraHeaders = mapped.retryAfterSeconds
      ? { 'Retry-After': String(mapped.retryAfterSeconds) }
      : undefined;
    return jsonResponse({ error: mapped.error }, mapped.status, extraHeaders);
  }
}

async function handleTranslate(
  request: CloudflareRequest,
  env: CloudflareEnv,
  allowProxyFallback: boolean
): Promise<Response> {
  let body: TranslateBody;
  try {
    body = (await request.json()) as TranslateBody;
  } catch {
    return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
  }

  const rawText = typeof body.text === 'string' ? sanitizeInputText(body.text) : '';
  const mode: TranslationMode = body.mode === 'formal' ? 'formal' : 'chat';
  const targetLang: TargetLanguage = body.targetLang === 'vi' ? 'vi' : 'en';

  if (!rawText) {
    return jsonResponse({ error: 'Vui lòng nhập nội dung cần dịch.' }, 400);
  }

  if (rawText.length > 8000) {
    return jsonResponse({ error: 'Đoạn văn bản quá dài (tối đa 8.000 ký tự).' }, 400);
  }

  const payload: NormalizedTranslatePayload = {
    text: rawText,
    mode,
    targetLang,
    model: typeof body.model === 'string' ? body.model.trim() : undefined,
    regenerate: body.regenerate,
  };
  const colo = (request.cf?.colo ?? '').toUpperCase();

  if (allowProxyFallback && colo && RESTRICTED_COLOS.has(colo) && env.GEMINI_PROXY) {
    const proxied = await forwardToUsProxy(env, payload);
    if (proxied) {
      return proxied;
    }
  }

  return runGeminiTranslation(payload, env, allowProxyFallback);
}

export class GeminiRegionProxy {
  private readonly env: CloudflareEnv;

  constructor(_ctx: unknown, env: CloudflareEnv) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/ping') {
      const apiKey = await resolveApiKey(this.env);
      if (apiKey) getOrCreateClient(apiKey);
      return new Response(null, { status: 204 });
    }
    return handleTranslate(request as CloudflareRequest, this.env, false);
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/ping') {
      const colo = ((request as CloudflareRequest).cf?.colo ?? '').toUpperCase();
      if (colo && RESTRICTED_COLOS.has(colo) && env.GEMINI_PROXY) {
        const id = env.GEMINI_PROXY.idFromName('gemini-us-west-v1');
        const stub = env.GEMINI_PROXY.get(id, { locationHint: 'wnam' });
        await stub.fetch(new Request('https://gemini-proxy.internal/api/ping'));
      } else {
        const apiKey = await resolveApiKey(env);
        if (apiKey) getOrCreateClient(apiKey);
      }
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/translate') {
      return handleTranslate(request as CloudflareRequest, env, true);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.ok && url.pathname.startsWith('/assets/')) {
      const headers = new Headers(assetResponse.headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    return assetResponse;
  },
};
