import { GoogleGenAI } from '@google/genai';
import { TargetLanguage, TranslationMode, VoiceGender } from './shared/prompts';
import { EdgeSocketConnector, synthesizeWithEdgeTts } from './shared/edgeTts';
import {
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
    const opened = await openTranslateStreamWithFallback(ai, {
      text: payload.text,
      mode: payload.mode,
      targetLang: payload.targetLang,
      regenerate: payload.regenerate,
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
      const proxied = await forwardToUsProxy(env, '/api/translate', payload);
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
  const colo = (request.cf?.colo ?? '').toUpperCase();

  if (allowProxyFallback && colo && RESTRICTED_COLOS.has(colo) && env.GEMINI_PROXY) {
    const proxied = await forwardToUsProxy(env, '/api/translate', payload);
    if (proxied) {
      return proxied;
    }
  }

  return runGeminiTranslation(payload, env, allowProxyFallback);
}

async function runGeminiStudy(
  payload: NormalizedStudyPayload,
  env: CloudflareEnv,
  allowProxyFallback: boolean
): Promise<Response> {
  const apiKey = await resolveApiKey(env);
  if (!apiKey) {
    return missingKeyResponse(env);
  }

  try {
    const ai = getOrCreateClient(apiKey);
    const analysis = await generateStudyAnalysis(ai, payload);
    return jsonResponse(analysis as unknown as Record<string, unknown>, 200, {
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    const info = inspectGeminiError(err);

    if (allowProxyFallback && info.isLocationUnsupported && env.GEMINI_PROXY) {
      const proxied = await forwardToUsProxy(env, '/api/study', payload);
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

async function handleStudy(
  request: CloudflareRequest,
  env: CloudflareEnv,
  allowProxyFallback: boolean
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
  const colo = (request.cf?.colo ?? '').toUpperCase();

  if (allowProxyFallback && colo && RESTRICTED_COLOS.has(colo) && env.GEMINI_PROXY) {
    const proxied = await forwardToUsProxy(env, '/api/study', payload);
    if (proxied) {
      return proxied;
    }
  }

  return runGeminiStudy(payload, env, allowProxyFallback);
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
    return new Response(speech.audioBytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': speech.mimeType,
        'X-Cydia-Translate': '1',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return jsonResponse({ error: 'Không thể tạo giọng đọc lúc này.' }, 502);
  }
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
    if (request.method === 'POST' && url.pathname === '/api/study') {
      return handleStudy(request as CloudflareRequest, this.env, false);
    }
    if (request.method === 'POST' && url.pathname === '/api/tts') {
      return handleTts(request as CloudflareRequest);
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

    if (request.method === 'POST' && url.pathname === '/api/study') {
      return handleStudy(request as CloudflareRequest, env, true);
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
