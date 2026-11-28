import { GoogleGenAI } from '@google/genai';
import { VoiceGender } from './prompts';
import { ProviderRouteError, RouterEnvConfig } from './llmRouter';
import { formatGeminiUserError, inspectGeminiError } from './translateStream';

export const LIVE_TALK_MODEL = 'gemini-3.8-live' as const;

export const LIVE_TALK_SYSTEM_INSTRUCTION = `You are Cydia, a warm, friendly native English speaking partner helping a Vietnamese learner practice real-life spoken English in real time.

Guidelines:
- Speak naturally like a real native friend in a relaxed voice call (contractions, everyday expressions, natural warmth).
- Keep EVERY reply short and conversational: 1 to 3 concise sentences, ending with a light follow-up question or prompt to keep the conversation flowing naturally.
- Gentle feedback ONLY when needed: if the learner makes a noticeable grammar or word-choice mistake, first respond naturally to their meaning, then weave in one very brief, friendly phrasing tip (e.g. "By the way, you can also say 'I went there yesterday'—sounds super natural!"). Never lecture, never list rules, and skip corrections if their sentence is already fine.
- If the learner mixes in a Vietnamese word because they got stuck, understand it warmly, give the natural English expression, and keep talking in English.
- Plain spoken English only: NEVER use markdown, bullet points, asterisks, emojis, or stage directions.`;

export interface PracticeTurnMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface PracticeTurnResult {
  reply: string;
  provider: 'groq' | 'cloudflare-ai' | 'gemini';
}

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PRACTICE_GEMINI_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;
const PRACTICE_TIMEOUT_MS = 16_000;

let groqPracticeCursor = 0;

export function pickLiveVoiceName(voiceGender: VoiceGender): 'Zephyr' | 'Puck' {
  return voiceGender === 'male' ? 'Puck' : 'Zephyr';
}

function cleanSpokenReply(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[*_`#>-]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function createAbortWithTimeout(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function buildOpenAiMessages(history: PracticeTurnMessage[]): Array<{ role: string; content: string }> {
  const trimmed = history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim().length > 0)
    .slice(-14);

  if (trimmed.length === 0) {
    return [
      { role: 'system', content: LIVE_TALK_SYSTEM_INSTRUCTION },
      {
        role: 'user',
        content:
          'Start our English speaking practice right now with a short, warm 1-sentence greeting and a casual opening question.',
      },
    ];
  }

  return [
    { role: 'system', content: LIVE_TALK_SYSTEM_INSTRUCTION },
    ...trimmed.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text.trim(),
    })),
  ];
}

async function callGroqPractice(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const timeout = createAbortWithTimeout(PRACTICE_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.75,
        max_tokens: 180,
      }),
      signal: timeout.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`GROQ_PRACTICE_HTTP_${res.status}: ${errBody.slice(0, 160)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = cleanSpokenReply(data.choices?.[0]?.message?.content ?? '');
    if (!reply) throw new Error('GROQ_PRACTICE_EMPTY');
    return reply;
  } finally {
    timeout.clear();
  }
}

async function callCloudflarePractice(
  config: RouterEnvConfig,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  if (config.cfAiBinding) {
    const out = (await config.cfAiBinding.run(model, {
      messages,
      max_tokens: 180,
      temperature: 0.75,
    })) as { response?: string; choices?: Array<{ message?: { content?: string } }> } | null;
    const raw = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
    const reply = cleanSpokenReply(raw);
    if (!reply) throw new Error('CF_PRACTICE_EMPTY');
    return reply;
  }

  if (config.cfAiRest) {
    const timeout = createAbortWithTimeout(PRACTICE_TIMEOUT_MS);
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${config.cfAiRest.accountId}/ai/run/${model}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.cfAiRest.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages, max_tokens: 180, temperature: 0.75 }),
        signal: timeout.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`CF_PRACTICE_HTTP_${res.status}: ${errBody.slice(0, 160)}`);
      }

      const data = (await res.json()) as {
        result?: { response?: string; choices?: Array<{ message?: { content?: string } }> };
      };
      const raw = data.result?.response ?? data.result?.choices?.[0]?.message?.content ?? '';
      const reply = cleanSpokenReply(raw);
      if (!reply) throw new Error('CF_PRACTICE_EMPTY');
      return reply;
    } finally {
      timeout.clear();
    }
  }

  throw new Error('CF_PRACTICE_UNCONFIGURED');
}

function getOrCreateGeminiClient(config: RouterEnvConfig, apiKey: string): GoogleGenAI {
  if (config.geminiClients) {
    const existing = config.geminiClients.get(apiKey);
    if (existing) return existing;
    const created = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    config.geminiClients.set(apiKey, created);
    return created;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
}

async function callGeminiPractice(
  ai: GoogleGenAI,
  history: PracticeTurnMessage[]
): Promise<string> {
  const trimmed = history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim().length > 0)
    .slice(-14);

  const contents =
    trimmed.length === 0
      ? 'Start our English speaking practice right now with a short, warm 1-sentence greeting and a casual opening question.'
      : trimmed.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text.trim() }],
        }));

  let lastErr: unknown = null;
  for (const model of PRACTICE_GEMINI_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: LIVE_TALK_SYSTEM_INSTRUCTION,
        },
      });
      const reply = cleanSpokenReply(response.text ?? '');
      if (reply) return reply;
    } catch (err: unknown) {
      lastErr = err;
      const info = inspectGeminiError(err);
      if (info.isNotFound || info.isTransient) {
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('GEMINI_PRACTICE_FAILED');
}

export async function routePracticeTurn(
  history: PracticeTurnMessage[],
  config: RouterEnvConfig
): Promise<PracticeTurnResult> {
  const messages = buildOpenAiMessages(history);
  let lastErr: unknown = null;

  // 1. Groq (sub-second conversational replies)
  if (config.groqApiKeys.length > 0) {
    const startIdx = groqPracticeCursor % config.groqApiKeys.length;
    groqPracticeCursor = (groqPracticeCursor + 1) % config.groqApiKeys.length;

    for (const model of config.groqModels) {
      for (let i = 0; i < config.groqApiKeys.length; i++) {
        const key = config.groqApiKeys[(startIdx + i) % config.groqApiKeys.length];
        try {
          const reply = await callGroqPractice(key, model, messages);
          return { reply, provider: 'groq' };
        } catch (err: unknown) {
          lastErr = err;
        }
      }
    }
  }

  // 2. Cloudflare Workers AI
  if (config.cfAiBinding || config.cfAiRest) {
    for (const model of config.cfAiModels) {
      try {
        const reply = await callCloudflarePractice(config, model, messages);
        return { reply, provider: 'cloudflare-ai' };
      } catch (err: unknown) {
        lastErr = err;
      }
    }
  }

  // 3. Gemini fallback
  if (config.geminiApiKeys.length > 0) {
    for (const key of config.geminiApiKeys) {
      try {
        const ai = getOrCreateGeminiClient(config, key);
        const reply = await callGeminiPractice(ai, history);
        return { reply, provider: 'gemini' };
      } catch (err: unknown) {
        lastErr = err;
      }
    }
  }

  if (lastErr) {
    const mapped = formatGeminiUserError(inspectGeminiError(lastErr), config.envLabel);
    throw new ProviderRouteError(
      mapped.error || 'Không thể kết nối robot luyện nói lúc này.',
      mapped.status || 502,
      mapped.retryAfterSeconds
    );
  }

  throw new ProviderRouteError('Chưa cấu hình dịch vụ AI luyện giao tiếp.', 503);
}
