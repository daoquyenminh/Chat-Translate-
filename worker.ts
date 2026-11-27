import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  CHAT_SYSTEM_INSTRUCTION,
  FORMAL_SYSTEM_INSTRUCTION,
  TRANSCRIBE_MODEL,
  TRANSCRIBE_PROMPT,
  TRANSLATE_MODEL,
  TranslationMode,
  buildTranslatePrompt,
} from './shared/prompts';

interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

interface CloudflareEnv {
  GEMINI_API_KEY?: string;
  ASSETS: AssetsFetcher;
}

interface TranslateBody {
  text?: string;
  mode?: TranslationMode;
  regenerate?: boolean;
}

interface TranscribeBody {
  audioBase64?: string;
  mimeType?: string;
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cydia-Translate': '1',
    },
  });
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

function mapGeminiError(err: unknown, fallbackMessage: string): Response {
  const errorObj = err as { status?: number; message?: string };
  const msg = errorObj?.message ?? '';

  if (
    errorObj?.status === 403 ||
    errorObj?.status === 400 ||
    msg.includes('API_KEY_INVALID') ||
    msg.includes('PERMISSION_DENIED')
  ) {
    return jsonResponse(
      { error: 'GEMINI_API_KEY không hợp lệ hoặc thiếu quyền. Kiểm tra lại trong Cloudflare Settings > Variables and Secrets.' },
      403
    );
  }

  if (errorObj?.status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
    return jsonResponse(
      { error: 'Đang vượt giới hạn lượt gọi tạm thời. Thử lại sau vài giây nhé.' },
      429
    );
  }

  return jsonResponse({ error: fallbackMessage }, 502);
}

async function handleTranslate(request: Request, env: CloudflareEnv): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse(
      { error: 'Chưa cấu hình GEMINI_API_KEY trong Cloudflare Workers > Settings > Variables and Secrets.' },
      500
    );
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
    const ai = createClient(env.GEMINI_API_KEY);
    const systemInstruction = mode === 'formal' ? FORMAL_SYSTEM_INSTRUCTION : CHAT_SYSTEM_INSTRUCTION;
    const contents = buildTranslatePrompt(rawText, body.regenerate);

    const streamResult = await ai.models.generateContentStream({
      model: TRANSLATE_MODEL,
      contents,
      config: {
        systemInstruction,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
      },
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of streamResult) {
            const piece = chunk.text ?? '';
            if (piece) {
              controller.enqueue(encoder.encode(piece));
            }
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
    return mapGeminiError(err, 'Không thể dịch lúc này. Vui lòng thử lại.');
  }
}

async function handleTranscribe(request: Request, env: CloudflareEnv): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse(
      { error: 'Chưa cấu hình GEMINI_API_KEY trong Cloudflare Workers > Settings > Variables and Secrets.' },
      500
    );
  }

  let body: TranscribeBody;
  try {
    body = (await request.json()) as TranscribeBody;
  } catch {
    return jsonResponse({ error: 'Dữ liệu âm thanh không hợp lệ.' }, 400);
  }

  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
  const rawMime = typeof body.mimeType === 'string' ? body.mimeType.trim() : 'audio/webm';
  const mimeType = rawMime.split(';')[0] || 'audio/webm';

  if (!audioBase64) {
    return jsonResponse({ error: 'Không có dữ liệu âm thanh.' }, 400);
  }

  try {
    const ai = createClient(env.GEMINI_API_KEY);
    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          { text: TRANSCRIBE_PROMPT },
        ],
      },
    });

    return jsonResponse({ text: (response.text ?? '').trim() }, 200);
  } catch (err) {
    return mapGeminiError(err, 'Không nhận diện được giọng nói lúc này. Thử lại nhé.');
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/translate') {
      return handleTranslate(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/transcribe') {
      return handleTranscribe(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
