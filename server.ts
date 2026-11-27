import 'dotenv/config';
import express, { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  CHAT_SYSTEM_INSTRUCTION,
  FORMAL_SYSTEM_INSTRUCTION,
  TRANSLATE_MODEL,
  TranslationMode,
  buildTranslatePrompt,
} from './shared/prompts';

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
      const systemInstruction = mode === 'formal' ? FORMAL_SYSTEM_INSTRUCTION : CHAT_SYSTEM_INSTRUCTION;
      const contents = buildTranslatePrompt(rawText, body.regenerate);

      const stream = await ai.models.generateContentStream({
        model: TRANSLATE_MODEL,
        contents,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
        },
      });

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Cydia-Translate', '1');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');

      let hasOutput = false;
      for await (const chunk of stream) {
        const piece = chunk.text ?? '';
        if (piece) {
          hasOutput = true;
          res.write(piece);
        }
      }

      if (!hasOutput) {
        res.status(502).end();
        return;
      }

      res.end();
    } catch (err: unknown) {
      const errorObj = err as { status?: number; message?: string };
      const msg = errorObj?.message ?? '';

      if (res.headersSent) {
        res.end();
        return;
      }

      if (msg === 'MISSING_API_KEY') {
        res.status(500).json({
          error: 'Chưa cấu hình GEMINI_API_KEY trong Settings > Secrets.',
        });
        return;
      }

      if (
        errorObj?.status === 403 ||
        errorObj?.status === 400 ||
        msg.includes('API_KEY_INVALID') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        res.status(403).json({
          error: 'API key không hợp lệ hoặc thiếu quyền truy cập. Kiểm tra lại trong Settings > Secrets.',
        });
        return;
      }

      if (errorObj?.status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
        res.status(429).json({
          error: 'Đang vượt giới hạn lượt gọi tạm thời. Thử lại sau vài giây nhé.',
        });
        return;
      }

      console.error('[/api/translate] Gemini error:', err);
      res.status(502).json({
        error: 'Không thể dịch lúc này. Vui lòng thử lại.',
      });
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
