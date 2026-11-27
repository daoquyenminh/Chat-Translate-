import 'dotenv/config';
import express, { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { TranslationMode } from './shared/prompts';
import {
  formatGeminiUserError,
  inspectGeminiError,
  openTranslateStreamWithFallback,
} from './shared/translateStream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

interface TranslateRequestBody {
  text?: string;
  mode?: TranslationMode;
  regenerate?: boolean;
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

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.post('/api/translate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TranslateRequestBody;
    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    const mode: TranslationMode = body.mode === 'formal' ? 'formal' : 'chat';

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

  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

  if (isProd) {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
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
