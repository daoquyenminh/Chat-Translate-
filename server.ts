import 'dotenv/config';
import express, { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = 'gemini-3.1-flash-lite';
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

type TranslationMode = 'chat' | 'formal';

interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface TranslateRequestBody {
  text?: string;
  mode?: TranslationMode;
  history?: HistoryTurn[];
  regenerate?: boolean;
}

interface TranscribeRequestBody {
  audioBase64?: string;
  mimeType?: string;
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

const CHAT_SYSTEM_INSTRUCTION = `You are a fast plain-text English translator and grammar corrector.
STRICT RULES:
1. Output ONLY plain English text ready to copy. NEVER output HTML, code, markdown, quotes, explanations, or conversational replies.
2. Stay strictly faithful to the exact meaning, topic, and tense of the user's sentence. NEVER over-complicate, change the tense, or add words/ideas not in the original sentence (Example: "nếu tôi đưa cho bạn 1 cái thì sao" -> "What if I give u one?", NEVER "What would happen if I were to give one to you?").
3. If the input is Vietnamese or mixed Vietlish: translate it into natural, modern native English texting.
4. If the input is already in English: return that exact sentence with corrected grammar, spelling, capitalization, and natural phrasing while keeping the exact meaning and tense (Example: "hello hello i need a backup" -> "Hey, I need a backup.").
5. NEVER omit grammatical subjects. ALWAYS keep explicit subjects like "I", "you", "we", "he", "she", "they", "it" with their verbs (Example: "tôi cần chuyển cái này sang factory 2" -> "I gotta move this to factory 2", NEVER "need to move this to factory 2").
6. When asking for a favor or making a request, ALWAYS use "Could you..." / "Could I..." instead of "Can you..." / "Can I..." to sound polite (Example: "Could you give this to Mr. Mat?", NEVER "Can you give this to Mr. Mat?").
7. Keep sentences short, direct, and conversational like a native speaker texting. Use natural contractions or light abbreviations (gonna, gotta, kinda, rn, tbh, lmk, u) only when fitting. Keep proper nouns, brand/facility names, codes, and technical terms unchanged.`;

const FORMAL_SYSTEM_INSTRUCTION = `You are a fast plain-text professional English translator and grammar corrector.
STRICT RULES:
1. Output ONLY plain English text ready to copy. NEVER output HTML, code, markdown, quotes, explanations, or conversational replies.
2. Stay strictly faithful to the exact meaning, topic, and tense of the user's sentence. Use clear, natural, modern workplace English — NEVER use stiff, archaic, or overly wordy phrasing like "if I were to...", "what would happen if...", or "shall" (Example: "nếu tôi đưa cho bạn 1 cái thì sao" -> "What if I give you one?", NEVER "What would happen if I were to give one to you?").
3. If the input is Vietnamese or mixed Vietlish: translate it directly into clear, polite, natural standard English matching the original tense.
4. If the input is already in English: return that exact sentence with corrected grammar, spelling, capitalization, and punctuation in clear standard English while keeping the exact meaning and tense (Example: "hello hello i need a backup" -> "Hello, I need a backup.").
5. ALWAYS write complete, grammatically proper sentences with full subjects ("I", "you", "we", etc.), predicates, accurate capitalization, and proper punctuation (Example: "tôi cần chuyển cái này sang factory 2" -> "I need to transfer this to Factory 2.").
6. When making a request or asking for a favor, ALWAYS use polite modals like "Could you..." or "Could you please..." instead of "Can you..." (Example: "Could you please give this to Mr. Mat?", NEVER "Can you give this to Mr. Mat?").
7. Do NOT use slang or texting abbreviations (avoid u, rn, tbh, gonna, gotta). Keep proper nouns, brand/facility names, codes, and technical terms unchanged.`;

function buildPrompt(text: string, _history?: HistoryTurn[], regenerate?: boolean): string {
  if (regenerate) {
    return `Provide a slightly different natural English phrasing with the exact same meaning, same tense, and full subject:\n${text}`;
  }
  return text;
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.post('/api/transcribe', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as TranscribeRequestBody;
    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
    const rawMime = typeof body.mimeType === 'string' ? body.mimeType.trim() : 'audio/webm';
    const mimeType = rawMime.split(';')[0] || 'audio/webm';

    if (!audioBase64) {
      res.status(400).json({ error: 'Không có dữ liệu âm thanh.' });
      return;
    }

    try {
      const ai = getGenAIClient();
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
            {
              text: 'Transcribe the spoken audio accurately in its original spoken language (Vietnamese, English, or a mix of both). Output ONLY the plain transcribed text without explanations, labels, quotes, or timestamps. If there is only silence or no intelligible speech, output an empty string.',
            },
          ],
        },
      });

      const transcript = (response.text ?? '').trim();
      res.setHeader('X-Cydia-Translate', '1');
      res.json({ text: transcript });
    } catch (err: unknown) {
      const errorObj = err as { status?: number; message?: string };
      const msg = errorObj?.message ?? '';

      if (msg === 'MISSING_API_KEY') {
        res.status(500).json({
          error: 'Chưa cấu hình GEMINI_API_KEY trong Settings > Secrets.',
        });
        return;
      }

      if (errorObj?.status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
        res.status(429).json({
          error: 'Đang vượt giới hạn lượt gọi tạm thời. Thử lại sau vài giây nhé.',
        });
        return;
      }

      console.error('[/api/transcribe] Gemini error:', err);
      res.status(502).json({
        error: 'Không nhận diện được giọng nói lúc này. Thử lại nhé.',
      });
    }
  });

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
      const contents = buildPrompt(rawText, body.history, body.regenerate);

      const stream = await ai.models.generateContentStream({
        model: MODEL_NAME,
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
