import 'dotenv/config';
import express, { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import WebSocket from 'ws';
import { TargetLanguage, TranslationMode, VoiceGender } from './shared/prompts';
import { EdgeSocketConnector, synthesizeWithEdgeTts } from './shared/edgeTts';
import {
  DEFAULT_CF_AI_MODELS,
  DEFAULT_GROQ_MODELS,
  ProviderRouteError,
  RouterEnvConfig,
  parseKeyList,
  parseModelList,
  routeStudyAnalysis,
  routeTranslateStream,
  setCachedTranslation,
} from './shared/llmRouter';
import {
  formatGeminiUserError,
  inspectGeminiError,
  sanitizeInputText,
} from './shared/translateStream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

interface TranslateRequestBody {
  text?: string;
  mode?: TranslationMode;
  targetLang?: TargetLanguage;
  regenerate?: boolean;
}

interface StudyRequestBody {
  sourceText?: string;
  translatedText?: string;
  mode?: TranslationMode;
}

interface TtsRequestBody {
  text?: string;
  mode?: TranslationMode;
  voiceGender?: VoiceGender;
}

const serverGeminiClients = new Map<string, GoogleGenAI>();

function getServerRouterConfig(): RouterEnvConfig {
  const groqApiKeys = parseKeyList(process.env.GROQ_API_KEY, process.env.GROQ_API_KEYS);
  const geminiApiKeys = parseKeyList(
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEYS,
    process.env.GOOGLE_API_KEY
  );
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const cfApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';

  return {
    groqApiKeys,
    groqModels: parseModelList(process.env.GROQ_MODEL, DEFAULT_GROQ_MODELS),
    cfAiRest:
      cfAccountId && cfApiToken
        ? { accountId: cfAccountId, apiToken: cfApiToken }
        : undefined,
    cfAiModels: parseModelList(process.env.CF_AI_MODEL, DEFAULT_CF_AI_MODELS),
    geminiApiKeys,
    geminiClients: serverGeminiClients,
    envLabel: 'server',
  };
}

const nodeEdgeSocketConnector: EdgeSocketConnector = async ({ url, headers, timeoutMs }) => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => {
      if (ws.readyState === WebSocket.OPEN) {
        cb();
      } else {
        ws.once('open', cb);
      }
    },
    onTextMessage: (cb) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          cb(data.toString());
        }
      });
    },
    onBinaryMessage: (cb) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
          cb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        }
      });
    },
    onError: (cb) => {
      ws.on('unexpected-response', (_req, res) => {
        const err = new Error(`EDGE_HTTP_${res.statusCode ?? 0}`) as Error & {
          statusCode?: number;
          serverDate?: string;
        };
        err.statusCode = res.statusCode;
        err.serverDate = typeof res.headers.date === 'string' ? res.headers.date : undefined;
        cb(err);
      });
      ws.on('error', (err) => {
        cb(err instanceof Error ? err : new Error(String(err)));
      });
    },
    onClose: (cb) => {
      ws.on('close', cb);
    },
  };
};

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/api/ping', (_req: Request, res: Response) => {
    getServerRouterConfig();
    res.setHeader('Cache-Control', 'no-store');
    res.status(204).end();
  });

  app.post('/api/translate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TranslateRequestBody;
    const rawText = typeof body.text === 'string' ? sanitizeInputText(body.text) : '';
    const mode: TranslationMode = body.mode === 'chat' ? 'chat' : 'formal';
    const targetLang: TargetLanguage = body.targetLang === 'vi' ? 'vi' : 'en';

    if (!rawText) {
      res.status(400).json({ error: 'Vui lòng nhập nội dung cần dịch.' });
      return;
    }

    if (rawText.length > 8000) {
      res.status(400).json({ error: 'Đoạn văn bản quá dài (tối đa 8.000 ký tự).' });
      return;
    }

    try {
      const config = getServerRouterConfig();
      const opened = await routeTranslateStream(
        {
          text: rawText,
          mode,
          targetLang,
          regenerate: body.regenerate,
        },
        config
      );

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Cydia-Translate', '1');
      res.setHeader('X-Cydia-Provider', opened.provider);
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');

      let assembled = opened.firstChunk;
      res.write(opened.firstChunk);
      for await (const piece of opened.rest) {
        assembled += piece;
        res.write(piece);
      }

      if (opened.provider !== 'cache' && assembled.trim()) {
        setCachedTranslation(opened.cacheKey, assembled.trim());
      }

      res.end();
    } catch (err: unknown) {
      if (res.headersSent) {
        res.end();
        return;
      }

      if (err instanceof ProviderRouteError) {
        if (err.retryAfterSeconds) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
        }
        res.status(err.status).json({ error: err.message });
        return;
      }

      const info = inspectGeminiError(err);
      const mapped = formatGeminiUserError(info, 'server');
      if (mapped.retryAfterSeconds) {
        res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
      }

      console.error('[/api/translate] Provider error:', err);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/api/study', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as StudyRequestBody;
    const sourceText =
      typeof body.sourceText === 'string' ? sanitizeInputText(body.sourceText) : '';
    const translatedText =
      typeof body.translatedText === 'string' ? sanitizeInputText(body.translatedText) : '';
    const mode: TranslationMode = body.mode === 'chat' ? 'chat' : 'formal';

    if (!sourceText && !translatedText) {
      res.status(400).json({ error: 'Thiếu nội dung câu cần phân tích.' });
      return;
    }

    const safeSource = sourceText || translatedText;
    const safeTranslated = translatedText || sourceText;

    if (safeSource.length > 4000 || safeTranslated.length > 4000) {
      res.status(400).json({ error: 'Đoạn văn bản quá dài để phân tích học bài.' });
      return;
    }

    try {
      const config = getServerRouterConfig();
      const result = await routeStudyAnalysis(
        {
          sourceText: safeSource,
          translatedText: safeTranslated,
          mode,
        },
        config
      );

      res.setHeader('X-Cydia-Translate', '1');
      res.setHeader('X-Cydia-Provider', result.provider);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result.analysis);
    } catch (err: unknown) {
      if (err instanceof ProviderRouteError) {
        if (err.retryAfterSeconds) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
        }
        res.status(err.status).json({ error: err.message });
        return;
      }

      const info = inspectGeminiError(err);
      const mapped = formatGeminiUserError(info, 'server');
      if (mapped.retryAfterSeconds) {
        res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
      }
      console.error('[/api/study] Provider error:', err);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/api/tts', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TtsRequestBody;
    const rawText = typeof body.text === 'string' ? sanitizeInputText(body.text) : '';
    const voiceGender: VoiceGender = body.voiceGender === 'male' ? 'male' : 'female';

    if (!rawText) {
      res.status(400).json({ error: 'Thiếu nội dung cần đọc.' });
      return;
    }

    if (rawText.length > 2000) {
      res.status(400).json({ error: 'Đoạn văn bản quá dài để đọc phát âm.' });
      return;
    }

    try {
      const speech = await synthesizeWithEdgeTts(
        { text: rawText, voiceGender },
        nodeEdgeSocketConnector,
        'wss'
      );

      res.setHeader('X-Cydia-Translate', '1');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(200).json(speech);
    } catch (err: unknown) {
      console.warn('[/api/tts] Edge Neural TTS error:', (err as { message?: string })?.message ?? err);
      res.status(502).json({ error: 'Không thể tạo giọng đọc lúc này.' });
    }
  });

  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

  if (isProd) {
    const distDir = path.join(__dirname, 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '1y',
        immutable: true,
      })
    );
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cydia Translate running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
