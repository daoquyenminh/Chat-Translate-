import { GoogleGenAI } from '@google/genai';
import { StudyAnalysis, TargetLanguage, TranslationMode, VoiceGender } from './shared/prompts';
import { EdgeSocketConnector, synthesizeWithEdgeTts } from './shared/edgeTts';
import {
  CloudflareAiBinding,
  DEFAULT_CF_AI_MODELS,
  DEFAULT_GROQ_MODELS,
  ProviderRouteError,
  RouterEnvConfig,
  buildStudyCacheKey,
  buildTranslateCacheKey,
  parseKeyList,
  parseModelList,
  routeStudyAnalysis,
  routeTranslateStream,
  setCachedStudy,
  setCachedTranslation,
} from './shared/llmRouter';
import {
  OpenedTranslateStream,
  formatGeminiUserError,
  generateStudyAnalysis,
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

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface CloudflareRequest extends Request {
  cf?: {
    colo?: string;
    country?: string;
  };
}

interface CloudflareCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface CloudflareEnv {
  AI?: CloudflareAiBinding;
  GROQ_API_KEY?: SecretOrString;
  GROQ_API_KEYS?: SecretOrString;
  GROQ_MODEL?: SecretOrString;
  CF_AI_MODEL?: SecretOrString;
  GEMINI_API_KEY?: SecretOrString;
  GEMINI_API_KEYS?: SecretOrString;
  VITE_GEMINI_API_KEY?: SecretOrString;
  API_KEY?: SecretOrString;
  GOOGLE_API_KEY?: SecretOrString;
  GEMINI_PROXY?: DurableObjectNamespaceLike;
  ASSETS: AssetsFetcher;
  [key: string]: unknown;
}

interface TranslateBody {
  text?: string;
  mode?: TranslationMode;
  targetLang?: TargetLanguage;
  regenerate?: boolean;
}

interface NormalizedTranslatePayload {
  text: string;
  mode: TranslationMode;
  targetLang: TargetLanguage;
  regenerate?: boolean;
}

interface StudyBody {
  sourceText?: string;
  translatedText?: string;
  mode?: TranslationMode;
}

interface NormalizedStudyPayload {
  sourceText: string;
  translatedText: string;
  mode: TranslationMode;
}

interface TtsBody {
  text?: string;
  mode?: TranslationMode;
  voiceGender?: VoiceGender;
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

const EDGE_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const workerGeminiClients = new Map<string, GoogleGenAI>();

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
      // Ignore unavailable secret store binding
    }
  }
  return '';
}

async function resolveGeminiKeys(env: CloudflareEnv): Promise<string[]> {
  const values = await Promise.all([
    resolveSingleSecret(env.GEMINI_API_KEY),
    resolveSingleSecret(env.GEMINI_API_KEYS),
    resolveSingleSecret(env.VITE_GEMINI_API_KEY),
    resolveSingleSecret(env.API_KEY),
    resolveSingleSecret(env.GOOGLE_API_KEY),
  ]);
  return parseKeyList(...values);
}

async function resolveGroqKeys(env: CloudflareEnv): Promise<string[]> {
  const values = await Promise.all([
    resolveSingleSecret(env.GROQ_API_KEY),
    resolveSingleSecret(env.GROQ_API_KEYS),
  ]);
  return parseKeyList(...values);
}

function getEdgeCache(): CloudflareCacheLike | null {
  const globalCaches = (globalThis as unknown as { caches?: { default?: CloudflareCacheLike } }).caches;
  return globalCaches?.default ?? null;
}

async function buildEdgeCacheRequest(kind: 'translate' | 'study', key: string): Promise<Request> {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hashHex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return new Request(`https://cache.cydia-translate.internal/v1/${kind}/${hashHex}`, {
    method: 'GET',
  });
}

async function readEdgeCacheText(kind: 'translate' | 'study', key: string): Promise<string | null> {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const req = await buildEdgeCacheRequest(kind, key);
    const hit = await cache.match(req);
    if (!hit || !hit.ok) return null;
    const text = await hit.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function writeEdgeCacheText(
  kind: 'translate' | 'study',
  key: string,
  body: string,
  contentType: string
): Promise<void> {
  const cache = getEdgeCache();
  if (!cache || !body.trim()) return;
  try {
    const req = await buildEdgeCacheRequest(kind, key);
    const resp = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`,
      },
    });
    await cache.put(req, resp);
  } catch {
    // Cache write failures are non-fatal
  }
}

function getOrCreateGeminiClient(apiKey: string): GoogleGenAI {
  const existing = workerGeminiClients.get(apiKey);
  if (existing) return existing;
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  workerGeminiClients.set(apiKey, client);
  return client;
}

interface CloudflareWebSocket extends WebSocket {
  accept(): void;
}

const workerEdgeSocketConnector: EdgeSocketConnector = async ({ url, headers }) => {
  const resp = await fetch(url, {
    headers: {
      ...headers,
      Upgrade: 'websocket',
    },
  });

  const ws = (resp as Response & { webSocket?: CloudflareWebSocket }).webSocket;
  if (resp.status !== 101 || !ws) {
    const err = new Error(`EDGE_HTTP_${resp.status}`) as Error & {
      statusCode?: number;
      serverDate?: string;
    };
    err.statusCode = resp.status;
    err.serverDate = resp.headers.get('date') ?? undefined;
    throw err;
  }

  ws.accept();

  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => {
      queueMicrotask(cb);
    },
    onTextMessage: (cb) => {
      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          cb(event.data);
        }
      });
    },
    onBinaryMessage: (cb) => {
      ws.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          cb(new Uint8Array(event.data));
        } else if (ArrayBuffer.isView(event.data)) {
          cb(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        }
      });
    },
    onError: (cb) => {
      ws.addEventListener('error', () => {
        cb(new Error('EDGE_WORKER_WS_ERROR'));
      });
    },
    onClose: (cb) => {
      ws.addEventListener('close', () => cb());
    },
  };
};

async function forwardToUsProxy(
  env: CloudflareEnv,
  pathname: '/api/translate' | '/api/study',
  payload: NormalizedTranslatePayload | NormalizedStudyPayload
): Promise<Response | null> {
  if (!env.GEMINI_PROXY) return null;
  const id = env.GEMINI_PROXY.idFromName('gemini-us-west-v1');
  const stub = env.GEMINI_PROXY.get(id, { locationHint: 'wnam' });
  const proxyReq = new Request(`https://gemini-proxy.internal${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return stub.fetch(proxyReq);
}

async function openGeminiProxyStream(
  env: CloudflareEnv,
  payload: NormalizedTranslatePayload
): Promise<OpenedTranslateStream | null> {
  const resp = await forwardToUsProxy(env, '/api/translate', payload);
  if (!resp) return null;
  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(errText || `GEMINI_PROXY_HTTP_${resp.status}`) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let firstChunk = '';

  while (!firstChunk) {
    const { value, done } = await reader.read();
    if (done) {
      reader.releaseLock();
      throw new Error('EMPTY_PROXY_STREAM');
    }
    const piece = decoder.decode(value, { stream: true });
    if (piece) {
      firstChunk = piece;
    }
  }

  async function* restGenerator(): AsyncGenerator<string, void, unknown> {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        if (piece) yield piece;
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    firstChunk,
    rest: restGenerator(),
    modelUsed: 'gemini-proxy',
  };
}

async function runGeminiProxyStudy(
  env: CloudflareEnv,
  payload: NormalizedStudyPayload
): Promise<StudyAnalysis | null> {
  const resp = await forwardToUsProxy(env, '/api/study', payload);
  if (!resp) return null;
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(errText || `GEMINI_PROXY_HTTP_${resp.status}`) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }
  return (await resp.json()) as StudyAnalysis;
}

async function buildRouterConfig(
  env: CloudflareEnv,
  options: {
    preferGeminiProxy: boolean;
    translatePayload?: NormalizedTranslatePayload;
    studyPayload?: NormalizedStudyPayload;
    allowProxyFallback: boolean;
  }
): Promise<RouterEnvConfig> {
  const [groqApiKeys, geminiApiKeys, groqModelOverride, cfAiModelOverride] = await Promise.all([
    resolveGroqKeys(env),
    resolveGeminiKeys(env),
    resolveSingleSecret(env.GROQ_MODEL),
    resolveSingleSecret(env.CF_AI_MODEL),
  ]);

  return {
    groqApiKeys,
    groqModels: parseModelList(groqModelOverride, DEFAULT_GROQ_MODELS),
    cfAiBinding: env.AI,
    cfAiModels: parseModelList(cfAiModelOverride, DEFAULT_CF_AI_MODELS),
    geminiApiKeys,
    geminiClients: workerGeminiClients,
    preferGeminiProxy: options.allowProxyFallback && options.preferGeminiProxy,
    runGeminiTranslateViaProxy:
      options.allowProxyFallback && env.GEMINI_PROXY && options.translatePayload
        ? () => openGeminiProxyStream(env, options.translatePayload as NormalizedTranslatePayload)
        : undefined,
    runGeminiStudyViaProxy:
      options.allowProxyFallback && env.GEMINI_PROXY && options.studyPayload
        ? () => runGeminiProxyStudy(env, options.studyPayload as NormalizedStudyPayload)
        : undefined,
    envLabel: 'cloudflare',
  };
}

async function handleTranslate(
  request: CloudflareRequest,
  env: CloudflareEnv,
  ctx?: ExecutionContextLike
): Promise<Response> {
  let body: TranslateBody;
  try {
    body = (await request.json()) as TranslateBody;
  } catch {
    return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
  }

  const rawText = typeof body.text === 'string' ? sanitizeInputText(body.text) : '';
  const mode: TranslationMode = body.mode === 'chat' ? 'chat' : 'formal';
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
    regenerate: body.regenerate,
  };

  const cacheKey = buildTranslateCacheKey(payload);

  if (!payload.regenerate) {
    const edgeHit = await readEdgeCacheText('translate', cacheKey);
    if (edgeHit) {
      setCachedTranslation(cacheKey, edgeHit);
      return new Response(edgeHit, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Cydia-Translate': '1',
          'X-Cydia-Provider': 'edge-cache',
          'Cache-Control': 'no-cache, no-transform',
        },
      });
    }
  }

  const colo = (request.cf?.colo ?? '').toUpperCase();
  const config = await buildRouterConfig(env, {
    preferGeminiProxy: Boolean(colo && RESTRICTED_COLOS.has(colo)),
    translatePayload: payload,
    allowProxyFallback: true,
  });

  try {
    const opened = await routeTranslateStream(payload, config);

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        let assembled = opened.firstChunk;
        try {
          controller.enqueue(encoder.encode(opened.firstChunk));
          for await (const piece of opened.rest) {
            assembled += piece;
            controller.enqueue(encoder.encode(piece));
          }
          controller.close();

          const trimmed = assembled.trim();
          if (trimmed && opened.provider !== 'cache') {
            setCachedTranslation(opened.cacheKey, trimmed);
            const writePromise = writeEdgeCacheText(
              'translate',
              opened.cacheKey,
              trimmed,
              'text/plain; charset=utf-8'
            );
            if (ctx) {
              ctx.waitUntil(writePromise);
            }
          }
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
        'X-Cydia-Provider': opened.provider,
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (err: unknown) {
    if (err instanceof ProviderRouteError) {
      const extraHeaders = err.retryAfterSeconds
        ? { 'Retry-After': String(err.retryAfterSeconds) }
        : undefined;
      return jsonResponse({ error: err.message }, err.status, extraHeaders);
    }
    const mapped = formatGeminiUserError(inspectGeminiError(err), 'cloudflare');
    const extraHeaders = mapped.retryAfterSeconds
      ? { 'Retry-After': String(mapped.retryAfterSeconds) }
      : undefined;
    return jsonResponse({ error: mapped.error }, mapped.status, extraHeaders);
  }
}

async function handleStudy(
  request: CloudflareRequest,
  env: CloudflareEnv,
  ctx?: ExecutionContextLike
): Promise<Response> {
  let body: StudyBody;
  try {
    body = (await request.json()) as StudyBody;
  } catch {
    return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
  }

  const sourceText =
    typeof body.sourceText === 'string' ? sanitizeInputText(body.sourceText) : '';
  const translatedText =
    typeof body.translatedText === 'string' ? sanitizeInputText(body.translatedText) : '';
  const mode: TranslationMode = body.mode === 'chat' ? 'chat' : 'formal';

  if (!sourceText && !translatedText) {
    return jsonResponse({ error: 'Thiếu nội dung câu cần phân tích.' }, 400);
  }

  const safeSource = sourceText || translatedText;
  const safeTranslated = translatedText || sourceText;

  if (safeSource.length > 4000 || safeTranslated.length > 4000) {
    return jsonResponse({ error: 'Đoạn văn bản quá dài để phân tích học bài.' }, 400);
  }

  const payload: NormalizedStudyPayload = {
    sourceText: safeSource,
    translatedText: safeTranslated,
    mode,
  };

  const cacheKey = buildStudyCacheKey(payload);
  const edgeHit = await readEdgeCacheText('study', cacheKey);
  if (edgeHit) {
    try {
      const parsed = JSON.parse(edgeHit) as StudyAnalysis;
      setCachedStudy(cacheKey, parsed);
      return jsonResponse(parsed as unknown as Record<string, unknown>, 200, {
        'X-Cydia-Provider': 'edge-cache',
        'Cache-Control': 'no-store',
      });
    } catch {
      // Ignore malformed cached payload
    }
  }

  const colo = (request.cf?.colo ?? '').toUpperCase();
  const config = await buildRouterConfig(env, {
    preferGeminiProxy: Boolean(colo && RESTRICTED_COLOS.has(colo)),
    studyPayload: payload,
    allowProxyFallback: true,
  });

  try {
    const result = await routeStudyAnalysis(payload, config);
    if (result.provider !== 'cache') {
      const writePromise = writeEdgeCacheText(
        'study',
        result.cacheKey,
        JSON.stringify(result.analysis),
        'application/json; charset=utf-8'
      );
      if (ctx) {
        ctx.waitUntil(writePromise);
      }
    }
    return jsonResponse(result.analysis as unknown as Record<string, unknown>, 200, {
      'X-Cydia-Provider': result.provider,
      'Cache-Control': 'no-store',
    });
  } catch (err: unknown) {
    if (err instanceof ProviderRouteError) {
      const extraHeaders = err.retryAfterSeconds
        ? { 'Retry-After': String(err.retryAfterSeconds) }
        : undefined;
      return jsonResponse({ error: err.message }, err.status, extraHeaders);
    }
    const mapped = formatGeminiUserError(inspectGeminiError(err), 'cloudflare');
    const extraHeaders = mapped.retryAfterSeconds
      ? { 'Retry-After': String(mapped.retryAfterSeconds) }
      : undefined;
    return jsonResponse({ error: mapped.error }, mapped.status, extraHeaders);
  }
}

async function handleTts(request: CloudflareRequest): Promise<Response> {
  let body: TtsBody;
  try {
    body = (await request.json()) as TtsBody;
  } catch {
    return jsonResponse({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400);
  }

  const rawText = typeof body.text === 'string' ? sanitizeInputText(body.text) : '';
  const voiceGender: VoiceGender = body.voiceGender === 'male' ? 'male' : 'female';

  if (!rawText) {
    return jsonResponse({ error: 'Thiếu nội dung cần đọc.' }, 400);
  }

  if (rawText.length > 2000) {
    return jsonResponse({ error: 'Đoạn văn bản quá dài để đọc phát âm.' }, 400);
  }

  try {
    const speech = await synthesizeWithEdgeTts(
      { text: rawText, voiceGender },
      workerEdgeSocketConnector,
      'https'
    );
    return jsonResponse(speech as unknown as Record<string, unknown>, 200, {
      'Cache-Control': 'private, max-age=3600',
    });
  } catch {
    return jsonResponse({ error: 'Không thể tạo giọng đọc lúc này.' }, 502);
  }
}

// Durable Object pinned to US-West exclusively as a geo-bypass hop for Gemini fallback
export class GeminiRegionProxy {
  private readonly env: CloudflareEnv;

  constructor(_ctx: unknown, env: CloudflareEnv) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const geminiKeys = await resolveGeminiKeys(this.env);

    if (request.method === 'GET' && url.pathname === '/api/ping') {
      if (geminiKeys[0]) getOrCreateGeminiClient(geminiKeys[0]);
      return new Response(null, { status: 204 });
    }

    if (geminiKeys.length === 0) {
      return jsonResponse({ error: 'Chưa có GEMINI_API_KEY cho proxy dự phòng.' }, 500);
    }

    if (request.method === 'POST' && url.pathname === '/api/study') {
      try {
        const payload = (await request.json()) as NormalizedStudyPayload;
        const ai = getOrCreateGeminiClient(geminiKeys[0]);
        const analysis = await generateStudyAnalysis(ai, payload);
        return jsonResponse(analysis as unknown as Record<string, unknown>, 200, {
          'Cache-Control': 'no-store',
        });
      } catch (err: unknown) {
        const mapped = formatGeminiUserError(inspectGeminiError(err), 'cloudflare');
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/translate') {
      try {
        const payload = (await request.json()) as NormalizedTranslatePayload;
        const ai = getOrCreateGeminiClient(geminiKeys[0]);
        const opened = await openTranslateStreamWithFallback(ai, payload);
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
      } catch (err: unknown) {
        const mapped = formatGeminiUserError(inspectGeminiError(err), 'cloudflare');
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    }

    return new Response(null, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx?: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/ping') {
      const config = await buildRouterConfig(env, {
        preferGeminiProxy: false,
        allowProxyFallback: false,
      });
      if (config.geminiApiKeys[0]) {
        getOrCreateGeminiClient(config.geminiApiKeys[0]);
      }
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/translate') {
      return handleTranslate(request as CloudflareRequest, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/api/study') {
      return handleStudy(request as CloudflareRequest, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/api/tts') {
      return handleTts(request as CloudflareRequest);
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
