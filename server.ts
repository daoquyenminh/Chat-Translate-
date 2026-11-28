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
  formatGeminiUserError,
  generateStudyAnalysis,
  inspectGeminiError,
  openTranslateStreamWithFallback,
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

let cachedClient: GoogleGenAI | null = null;

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('MISSING_API_KEY');
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
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
    try {
      getGenAIClient();
    } catch {
      // Ignore if key not yet configured
    }
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
      const ai = getGenAIClient();
      const opened = await openTranslateStreamWithFallback(ai, {
        text: rawText,
        mode,
        targetLang,
        regenerate: body.regenerate,
      });

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Cydia-Translate', '1');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');

      res.write(opened.firstChunk);
      for await (const piece of opened.rest) {
        res.write(piece);
      }

      res.end();
    } catch (err: unknown) {
      if (res.headersSent) {
        res.end();
        return;
      }

      if ((err as { message?: string })?.message === 'MISSING_API_KEY') {
        res.status(500).json({
          error: 'Chưa cấu hình GEMINI_API_KEY trong Settings > Secrets.',
        });
        return;
      }

      const info = inspectGeminiError(err);
      const mapped = formatGeminiUserError(info, 'server');

      if (mapped.retryAfterSeconds) {
        res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
      }

      console.error('[/api/translate] Gemini error:', err);
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
      const ai = getGenAIClient();
      const analysis = await generateStudyAnalysis(ai, {
        sourceText: safeSource,
        translatedText: safeTranslated,
        mode,
      });

      res.setHeader('X-Cydia-Translate', '1');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(analysis);
    } catch (err: unknown) {
      if ((err as { message?: string })?.message === 'MISSING_API_KEY') {
        res.status(500).json({
          error: 'Chưa cấu hình GEMINI_API_KEY trong Settings > Secrets.',
        });
        return;
      }

      const info = inspectGeminiError(err);
      const mapped = formatGeminiUserError(info, 'server');
      if (mapped.retryAfterSeconds) {
        res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
      }
      console.error('[/api/study] Gemini error:', err);
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
