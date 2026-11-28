import { GoogleGenAI } from '@google/genai';
import {
  CHAT_SYSTEM_INSTRUCTION,
  FORMAL_SYSTEM_INSTRUCTION,
  STUDY_SYSTEM_INSTRUCTION,
  StudyAnalysis,
  TargetLanguage,
  TranslationMode,
  VI_SYSTEM_INSTRUCTION,
  buildStudyPrompt,
  buildTranslatePrompt,
  buildViTranslatePrompt,
} from './prompts';
import {
  OpenedTranslateStream,
  formatGeminiUserError,
  generateStudyAnalysis,
  inspectGeminiError,
  normalizeStudyAnalysis,
  openTranslateStreamWithFallback,
} from './translateStream';

export type LlmProviderName = 'cache' | 'groq' | 'cloudflare-ai' | 'gemini';

export interface CloudflareAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface CloudflareAiRestCredentials {
  accountId: string;
  apiToken: string;
}

export interface RouterEnvConfig {
  groqApiKeys: string[];
  groqModels: string[];
  cfAiBinding?: CloudflareAiBinding;
  cfAiRest?: CloudflareAiRestCredentials;
  cfAiModels: string[];
  geminiApiKeys: string[];
  geminiClients?: Map<string, GoogleGenAI>;
  preferGeminiProxy?: boolean;
  runGeminiTranslateViaProxy?: () => Promise<OpenedTranslateStream | null>;
  runGeminiStudyViaProxy?: () => Promise<StudyAnalysis | null>;
  envLabel: 'cloudflare' | 'server';
}

export interface TranslateRouterOptions {
  text: string;
  mode: TranslationMode;
  targetLang: TargetLanguage;
  regenerate?: boolean;
}

export interface StudyRouterOptions {
  sourceText: string;
  translatedText: string;
  mode: TranslationMode;
}

export interface RoutedTranslateResult extends OpenedTranslateStream {
  provider: LlmProviderName;
  cacheKey: string;
}

export interface RoutedStudyResult {
  analysis: StudyAnalysis;
  provider: LlmProviderName;
  cacheKey: string;
}

export class ProviderRouteError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ProviderRouteError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const DEFAULT_GROQ_MODELS = [
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-120b',
] as const;

export const DEFAULT_CF_AI_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/google/gemma-3-12b-it',
  '@cf/meta/llama-3.1-8b-instruct',
] as const;

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PROVIDER_TIMEOUT_MS = 18_000;

const TRANSLATE_CACHE_MAX = 300;
const STUDY_CACHE_MAX = 200;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const translateLruCache = new Map<string, CacheEntry<string>>();
const studyLruCache = new Map<string, CacheEntry<StudyAnalysis>>();
const slotCooldownUntil = new Map<string, number>();

let groqKeyCursor = 0;
let geminiKeyCursor = 0;

export function parseKeyList(...sources: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of sources) {
    if (!raw) continue;
    const parts = raw.split(/[\n,;]+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        keys.push(trimmed);
      }
    }
  }
  return keys;
}

export function parseModelList(override: string | undefined, defaults: readonly string[]): string[] {
  const custom = parseKeyList(override);
  if (custom.length === 0) {
    return [...defaults];
  }
  const merged = [...custom];
  for (const fallback of defaults) {
    if (!merged.includes(fallback)) {
      merged.push(fallback);
    }
  }
  return merged;
}

export function buildTranslateCacheKey(options: TranslateRouterOptions): string {
  const normalized = options.text.trim().replace(/\s+/g, ' ');
  return `tr:v1:${options.mode}:${options.targetLang}:${normalized}`;
}

export function buildStudyCacheKey(options: StudyRouterOptions): string {
  const src = options.sourceText.trim().replace(/\s+/g, ' ');
  const tr = options.translatedText.trim().replace(/\s+/g, ' ');
  return `st:v1:${options.mode}:${src}:::${tr}`;
}

function getLru<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setLru<T>(cache: Map<string, CacheEntry<T>>, maxEntries: number, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function getCachedTranslation(cacheKey: string): string | undefined {
  return getLru(translateLruCache, cacheKey);
}

export function setCachedTranslation(cacheKey: string, value: string): void {
  const cleaned = value.trim();
  if (!cleaned) return;
  setLru(translateLruCache, TRANSLATE_CACHE_MAX, cacheKey, cleaned);
}

export function getCachedStudy(cacheKey: string): StudyAnalysis | undefined {
  return getLru(studyLruCache, cacheKey);
}

export function setCachedStudy(cacheKey: string, value: StudyAnalysis): void {
  setLru(studyLruCache, STUDY_CACHE_MAX, cacheKey, value);
}

function isCoolingDown(slotId: string): boolean {
  const until = slotCooldownUntil.get(slotId);
  if (!until) return false;
  if (until <= Date.now()) {
    slotCooldownUntil.delete(slotId);
    return false;
  }
  return true;
}

function setCooldown(slotId: string, durationMs: number): void {
  slotCooldownUntil.set(slotId, Date.now() + durationMs);
}

function rotateIndices(length: number, cursor: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < length; i++) {
    indices.push((cursor + i) % length);
  }
  return indices;
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const match = trimmed.match(/(\d+(?:\.\d+)?)s/i);
  if (match) {
    const parsed = Math.ceil(Number(match[1]));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function getTranslatePrompts(options: TranslateRouterOptions): {
  systemInstruction: string;
  userPrompt: string;
} {
  const systemInstruction =
    options.targetLang === 'vi'
      ? VI_SYSTEM_INSTRUCTION
      : options.mode === 'formal'
      ? FORMAL_SYSTEM_INSTRUCTION
      : CHAT_SYSTEM_INSTRUCTION;
  const userPrompt =
    options.targetLang === 'vi'
      ? buildViTranslatePrompt(options.text)
      : buildTranslatePrompt(options.text, options.regenerate);
  return { systemInstruction, userPrompt };
}

const STUDY_JSON_SCHEMA_PROMPT = `
Return ONLY one valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "inputType": "english" | "vietnamese" | "mixed",
  "hasMistakes": boolean,
  "originalSegments": [{ "text": string, "status": "normal" | "wrong" | "correct" | "key" }],
  "correctedSentence": string,
  "correctedSegments": [{ "text": string, "status": "normal" | "wrong" | "correct" | "key" }],
  "mistakes": [{ "wrong": string, "correct": string, "explanation": string }],
  "usageContext": string,
  "alternatives": [{ "english": string, "vietnamese": string, "tone": string }],
  "keyTakeaways": [{ "phrase": string, "meaning": string, "note": string }]
}`;

class ThinkTagStripper {
  private insideThink = false;
  private carry = '';

  push(chunk: string): string {
    let data = this.carry + chunk;
    this.carry = '';
    let out = '';

    while (data.length > 0) {
      if (this.insideThink) {
        const closeIdx = data.indexOf('</think>');
        if (closeIdx === -1) {
          // Keep trailing suffix that could start </think>
          const keep = Math.min(data.length, 7);
          this.carry = data.slice(data.length - keep);
          break;
        }
        data = data.slice(closeIdx + 8);
        this.insideThink = false;
      } else {
        const openIdx = data.indexOf('<think>');
        if (openIdx === -1) {
          const partialIdx = data.lastIndexOf('<');
          if (partialIdx !== -1 && data.length - partialIdx < 7) {
            out += data.slice(0, partialIdx);
            this.carry = data.slice(partialIdx);
          } else {
            out += data;
          }
          break;
        }
        out += data.slice(0, openIdx);
        data = data.slice(openIdx + 7);
        this.insideThink = true;
      }
    }

    return out;
  }

  flush(): string {
    if (this.insideThink) {
      this.carry = '';
      return '';
    }
    const remaining = this.carry;
    this.carry = '';
    return remaining;
  }
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractJsonObject(raw: string): Partial<StudyAnalysis> {
  const cleaned = stripThinkBlocks(raw)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as Partial<StudyAnalysis>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as Partial<StudyAnalysis>;
    }
    throw new Error('INVALID_STUDY_JSON');
  }
}

interface HttpProviderError extends Error {
  status: number;
  retryAfterSeconds: number | null;
  isDailyQuota: boolean;
}

function createHttpProviderError(
  provider: string,
  status: number,
  bodyText: string,
  retryAfterSeconds: number | null
): HttpProviderError {
  const err = new Error(`${provider}_HTTP_${status}: ${bodyText.slice(0, 220)}`) as HttpProviderError;
  err.status = status;
  err.retryAfterSeconds = retryAfterSeconds;
  err.isDailyQuota =
    status === 429 &&
    /per\s*day|daily|requests per day|tokens per day|neurons|quota/i.test(bodyText);
  return err;
}

function extractDeltaFromSseJson(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as {
    response?: unknown;
    choices?: Array<{
      delta?: { content?: unknown };
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };

  if (typeof obj.response === 'string') {
    return obj.response;
  }

  const firstChoice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
  if (firstChoice) {
    if (typeof firstChoice.delta?.content === 'string') {
      return firstChoice.delta.content;
    }
    if (typeof firstChoice.message?.content === 'string') {
      return firstChoice.message.content;
    }
    if (typeof firstChoice.text === 'string') {
      return firstChoice.text;
    }
  }

  return '';
}

async function* iterateSseTextStream(
  body: ReadableStream<Uint8Array>,
  stripThink = true
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const stripper = stripThink ? new ThinkTagStripper() : null;
  let buffer = '';

  const processLine = (line: string): string => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return '';
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return '';
    try {
      const parsed = JSON.parse(payload) as unknown;
      const delta = extractDeltaFromSseJson(parsed);
      if (!delta) return '';
      return stripper ? stripper.push(delta) : delta;
    } catch {
      return '';
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const piece = processLine(line);
        if (piece) {
          yield piece;
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const piece = processLine(line);
        if (piece) {
          yield piece;
        }
      }
    }

    if (stripper) {
      const tail = stripper.flush();
      if (tail) {
        yield tail;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function openBufferedStream(
  generator: AsyncGenerator<string, void, unknown>,
  modelUsed: string
): Promise<OpenedTranslateStream> {
  let firstChunk = '';

  while (!firstChunk) {
    const step = await generator.next();
    if (step.done) {
      throw new Error('EMPTY_STREAM_OUTPUT');
    }
    const piece = step.value;
    if (piece && piece.trim().length > 0) {
      firstChunk = piece;
    } else if (piece && firstChunk.length === 0) {
      // Ignore leading pure whitespace before first visible character
    }
  }

  async function* restGenerator(): AsyncGenerator<string, void, unknown> {
    while (true) {
      const step = await generator.next();
      if (step.done) break;
      if (step.value) {
        yield step.value;
      }
    }
  }

  return {
    firstChunk: firstChunk.replace(/^\s+/, ''),
    rest: restGenerator(),
    modelUsed,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = PROVIDER_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildGroqPayload(
  model: string,
  systemInstruction: string,
  userPrompt: string,
  options: { stream: boolean; temperature: number; jsonMode?: boolean; maxTokens: number }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    stream: options.stream,
    temperature: options.temperature,
    max_completion_tokens: options.maxTokens,
  };

  if (options.jsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  // Keep latency low & avoid reasoning token bloat on reasoning-capable Groq models
  if (model.startsWith('openai/gpt-oss-')) {
    payload.reasoning_effort = 'low';
  } else if (model.startsWith('qwen/')) {
    payload.reasoning_effort = 'none';
  }

  return payload;
}

async function openGroqTranslateStream(
  apiKey: string,
  model: string,
  systemInstruction: string,
  userPrompt: string,
  regenerate?: boolean
): Promise<OpenedTranslateStream> {
  const response = await fetchWithTimeout(GROQ_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      buildGroqPayload(model, systemInstruction, userPrompt, {
        stream: true,
        temperature: regenerate ? 0.6 : 0.2,
        maxTokens: 1024,
      })
    ),
  });

  if (!response.ok || !response.body) {
    const bodyText = await response.text().catch(() => '');
    throw createHttpProviderError(
      'GROQ',
      response.status,
      bodyText,
      parseRetryAfterHeader(response.headers.get('retry-after'))
    );
  }

  return openBufferedStream(iterateSseTextStream(response.body, true), model);
}

async function runGroqStudy(
  apiKey: string,
  model: string,
  options: StudyRouterOptions
): Promise<StudyAnalysis> {
  const prompt = `${buildStudyPrompt(options.sourceText, options.translatedText, options.mode)}\n${STUDY_JSON_SCHEMA_PROMPT}`;
  const response = await fetchWithTimeout(GROQ_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      buildGroqPayload(model, STUDY_SYSTEM_INSTRUCTION, prompt, {
        stream: false,
        temperature: 0.2,
        jsonMode: true,
        maxTokens: 1600,
      })
    ),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw createHttpProviderError(
      'GROQ',
      response.status,
      bodyText,
      parseRetryAfterHeader(response.headers.get('retry-after'))
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawText = data.choices?.[0]?.message?.content ?? '';
  if (!rawText.trim()) {
    throw new Error('EMPTY_GROQ_STUDY_OUTPUT');
  }
  const parsed = extractJsonObject(rawText);
  return normalizeStudyAnalysis(parsed, options.sourceText, options.translatedText);
}

function extractTextFromCloudflareResponse(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const obj = result as {
    response?: unknown;
    result?: { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof obj.response === 'string') return obj.response;
  if (typeof obj.result?.response === 'string') return obj.result.response;
  const choiceText = obj.choices?.[0]?.message?.content ?? obj.result?.choices?.[0]?.message?.content;
  if (typeof choiceText === 'string') return choiceText;
  return '';
}

async function openCloudflareAiTranslateStream(
  config: RouterEnvConfig,
  model: string,
  systemInstruction: string,
  userPrompt: string,
  regenerate?: boolean
): Promise<OpenedTranslateStream> {
  const input = {
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    temperature: regenerate ? 0.6 : 0.2,
    max_tokens: 1024,
  };

  if (config.cfAiBinding) {
    const raw = await config.cfAiBinding.run(model, input);
    if (raw instanceof ReadableStream) {
      return openBufferedStream(
        iterateSseTextStream(raw as ReadableStream<Uint8Array>, true),
        model
      );
    }
    const text = stripThinkBlocks(extractTextFromCloudflareResponse(raw));
    if (!text) {
      throw new Error('EMPTY_CF_AI_OUTPUT');
    }
    async function* singleChunk(): AsyncGenerator<string, void, unknown> {
      // Nothing left after firstChunk
    }
    return {
      firstChunk: text,
      rest: singleChunk(),
      modelUsed: model,
    };
  }

  if (config.cfAiRest) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      config.cfAiRest.accountId
    )}/ai/run/${model}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cfAiRest.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => '');
      throw createHttpProviderError(
        'CF_AI',
        response.status,
        bodyText,
        parseRetryAfterHeader(response.headers.get('retry-after'))
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return openBufferedStream(iterateSseTextStream(response.body, true), model);
    }
    const json = (await response.json()) as unknown;
    const text = stripThinkBlocks(extractTextFromCloudflareResponse(json));
    if (!text) {
      throw new Error('EMPTY_CF_AI_OUTPUT');
    }
    async function* emptyRest(): AsyncGenerator<string, void, unknown> {
      // Single chunk already returned
    }
    return { firstChunk: text, rest: emptyRest(), modelUsed: model };
  }

  throw new Error('CF_AI_UNAVAILABLE');
}

async function runCloudflareAiStudy(
  config: RouterEnvConfig,
  model: string,
  options: StudyRouterOptions
): Promise<StudyAnalysis> {
  const prompt = `${buildStudyPrompt(options.sourceText, options.translatedText, options.mode)}\n${STUDY_JSON_SCHEMA_PROMPT}`;
  const input = {
    messages: [
      { role: 'system', content: STUDY_SYSTEM_INSTRUCTION },
      { role: 'user', content: prompt },
    ],
    stream: false,
    temperature: 0.2,
    max_tokens: 1600,
    response_format: { type: 'json_object' },
  };

  let rawResult: unknown;
  if (config.cfAiBinding) {
    rawResult = await config.cfAiBinding.run(model, input);
  } else if (config.cfAiRest) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      config.cfAiRest.accountId
    )}/ai/run/${model}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cfAiRest.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw createHttpProviderError(
        'CF_AI',
        response.status,
        bodyText,
        parseRetryAfterHeader(response.headers.get('retry-after'))
      );
    }
    rawResult = await response.json();
  } else {
    throw new Error('CF_AI_UNAVAILABLE');
  }

  const rawText = extractTextFromCloudflareResponse(rawResult);
  if (!rawText.trim()) {
    throw new Error('EMPTY_CF_AI_STUDY_OUTPUT');
  }
  const parsed = extractJsonObject(rawText);
  return normalizeStudyAnalysis(parsed, options.sourceText, options.translatedText);
}

function getOrCreateGeminiClient(apiKey: string, cache?: Map<string, GoogleGenAI>): GoogleGenAI {
  if (cache) {
    const existing = cache.get(apiKey);
    if (existing) return existing;
  }
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  cache?.set(apiKey, client);
  return client;
}

function applyHttpCooldown(slotId: string, err: unknown): {
  isRateLimit: boolean;
  retryAfterSeconds: number | null;
} {
  const httpErr = err as Partial<HttpProviderError> | null;
  const status = typeof httpErr?.status === 'number' ? httpErr.status : 0;
  const retryAfterSeconds =
    typeof httpErr?.retryAfterSeconds === 'number' ? httpErr.retryAfterSeconds : null;

  if (status === 429) {
    const cooldownMs = httpErr?.isDailyQuota
      ? 10 * 60 * 1000
      : Math.max(20_000, Math.min(90_000, (retryAfterSeconds ?? 30) * 1000));
    setCooldown(slotId, cooldownMs);
    return { isRateLimit: true, retryAfterSeconds };
  }

  if (status === 401 || status === 403) {
    setCooldown(slotId, 10 * 60 * 1000);
    return { isRateLimit: false, retryAfterSeconds: null };
  }

  if (status === 404) {
    setCooldown(slotId, 30 * 60 * 1000);
    return { isRateLimit: false, retryAfterSeconds: null };
  }

  if (status >= 500 || status === 0) {
    setCooldown(slotId, 15_000);
  }

  return { isRateLimit: false, retryAfterSeconds: null };
}

export function hasAnyConfiguredProvider(config: RouterEnvConfig): boolean {
  return (
    config.groqApiKeys.length > 0 ||
    Boolean(config.cfAiBinding) ||
    Boolean(config.cfAiRest) ||
    config.geminiApiKeys.length > 0
  );
}

function buildMissingProviderError(envLabel: 'cloudflare' | 'server'): ProviderRouteError {
  const msg =
    envLabel === 'cloudflare'
      ? 'Chưa có nguồn AI nào được cấu hình trên Cloudflare Worker (cần bật AI binding, hoặc thêm GROQ_API_KEY / GEMINI_API_KEY trong Variables and Secrets).'
      : 'Chưa cấu hình GROQ_API_KEY hoặc GEMINI_API_KEY trong Settings > Secrets.';
  return new ProviderRouteError(msg, 500);
}

export async function routeTranslateStream(
  options: TranslateRouterOptions,
  config: RouterEnvConfig
): Promise<RoutedTranslateResult> {
  const cacheKey = buildTranslateCacheKey(options);

  if (!options.regenerate) {
    const cached = getCachedTranslation(cacheKey);
    if (cached) {
      async function* emptyRest(): AsyncGenerator<string, void, unknown> {
        // Complete text served from cache
      }
      return {
        firstChunk: cached,
        rest: emptyRest(),
        modelUsed: 'cache',
        provider: 'cache',
        cacheKey,
      };
    }
  }

  if (!hasAnyConfiguredProvider(config)) {
    throw buildMissingProviderError(config.envLabel);
  }

  const { systemInstruction, userPrompt } = getTranslatePrompts(options);
  let sawRateLimit = false;
  let bestRetryAfter: number | null = null;
  let lastGeminiError: unknown = null;

  // Tier 1: Groq Cloud (fastest, round-robin keys + active model fallback)
  if (config.groqApiKeys.length > 0) {
    const keyOrder = rotateIndices(config.groqApiKeys.length, groqKeyCursor);
    groqKeyCursor = (groqKeyCursor + 1) % config.groqApiKeys.length;

    for (const model of config.groqModels) {
      if (isCoolingDown(`groq:model:${model}`)) continue;
      for (const keyIdx of keyOrder) {
        const slotId = `groq:key:${keyIdx}:${model}`;
        if (isCoolingDown(slotId)) continue;
        try {
          const opened = await openGroqTranslateStream(
            config.groqApiKeys[keyIdx],
            model,
            systemInstruction,
            userPrompt,
            options.regenerate
          );
          return { ...opened, provider: 'groq', cacheKey };
        } catch (err: unknown) {
          const info = applyHttpCooldown(slotId, err);
          if ((err as Partial<HttpProviderError>)?.status === 404) {
            setCooldown(`groq:model:${model}`, 30 * 60 * 1000);
            break;
          }
          if (info.isRateLimit) {
            sawRateLimit = true;
            if (info.retryAfterSeconds !== null) {
              bestRetryAfter =
                bestRetryAfter === null
                  ? info.retryAfterSeconds
                  : Math.min(bestRetryAfter, info.retryAfterSeconds);
            }
          }
        }
      }
    }
  }

  // Tier 2: Cloudflare Workers AI (edge-native, zero external key on Cloudflare)
  if (config.cfAiBinding || config.cfAiRest) {
    for (const model of config.cfAiModels) {
      const slotId = `cf-ai:${model}`;
      if (isCoolingDown(slotId)) continue;
      try {
        const opened = await openCloudflareAiTranslateStream(
          config,
          model,
          systemInstruction,
          userPrompt,
          options.regenerate
        );
        return { ...opened, provider: 'cloudflare-ai', cacheKey };
      } catch (err: unknown) {
        const info = applyHttpCooldown(slotId, err);
        if (info.isRateLimit) {
          sawRateLimit = true;
        }
      }
    }
  }

  // Tier 3: Gemini Flash Lite (multi-key + optional US-West geo-proxy)
  if (config.geminiApiKeys.length > 0) {
    if (config.preferGeminiProxy && config.runGeminiTranslateViaProxy) {
      try {
        const proxied = await config.runGeminiTranslateViaProxy();
        if (proxied) {
          return { ...proxied, provider: 'gemini', cacheKey };
        }
      } catch (err: unknown) {
        lastGeminiError = err;
      }
    }

    const keyOrder = rotateIndices(config.geminiApiKeys.length, geminiKeyCursor);
    geminiKeyCursor = (geminiKeyCursor + 1) % config.geminiApiKeys.length;

    for (const keyIdx of keyOrder) {
      const slotId = `gemini:key:${keyIdx}`;
      if (isCoolingDown(slotId)) continue;
      try {
        const ai = getOrCreateGeminiClient(config.geminiApiKeys[keyIdx], config.geminiClients);
        const opened = await openTranslateStreamWithFallback(ai, options);
        return { ...opened, provider: 'gemini', cacheKey };
      } catch (err: unknown) {
        lastGeminiError = err;
        const info = inspectGeminiError(err);
        if (info.isRateLimit) {
          sawRateLimit = true;
          setCooldown(slotId, info.isDailyQuota ? 10 * 60 * 1000 : 35_000);
          if (info.retryAfterSeconds !== null) {
            bestRetryAfter =
              bestRetryAfter === null
                ? info.retryAfterSeconds
                : Math.min(bestRetryAfter, info.retryAfterSeconds);
          }
        } else if (info.isAuthError) {
          setCooldown(slotId, 10 * 60 * 1000);
        } else if (info.isLocationUnsupported && config.runGeminiTranslateViaProxy) {
          try {
            const proxied = await config.runGeminiTranslateViaProxy();
            if (proxied) {
              return { ...proxied, provider: 'gemini', cacheKey };
            }
          } catch (proxyErr: unknown) {
            lastGeminiError = proxyErr;
          }
          break;
        }
      }
    }
  }

  if (sawRateLimit) {
    const waitText =
      bestRetryAfter && bestRetryAfter <= 90
        ? ` Vui lòng thử lại sau khoảng ${bestRetryAfter} giây.`
        : ' Vui lòng đợi vài giây rồi thử lại.';
    throw new ProviderRouteError(
      `Các nguồn dịch miễn phí đang tạm quá tải lượt gọi cùng lúc (429).${waitText}`,
      429,
      bestRetryAfter ?? undefined
    );
  }

  if (lastGeminiError) {
    const mapped = formatGeminiUserError(inspectGeminiError(lastGeminiError), config.envLabel);
    throw new ProviderRouteError(mapped.error, mapped.status, mapped.retryAfterSeconds);
  }

  throw new ProviderRouteError(
    'Không thể kết nối tới nguồn dịch lúc này. Vui lòng thử lại sau giây lát.',
    502
  );
}

export async function routeStudyAnalysis(
  options: StudyRouterOptions,
  config: RouterEnvConfig
): Promise<RoutedStudyResult> {
  const cacheKey = buildStudyCacheKey(options);
  const cached = getCachedStudy(cacheKey);
  if (cached) {
    return { analysis: cached, provider: 'cache', cacheKey };
  }

  if (!hasAnyConfiguredProvider(config)) {
    throw buildMissingProviderError(config.envLabel);
  }

  let sawRateLimit = false;
  let bestRetryAfter: number | null = null;
  let lastGeminiError: unknown = null;

  // Tier 1: Groq Cloud
  if (config.groqApiKeys.length > 0) {
    const keyOrder = rotateIndices(config.groqApiKeys.length, groqKeyCursor);
    groqKeyCursor = (groqKeyCursor + 1) % config.groqApiKeys.length;

    for (const model of config.groqModels) {
      if (isCoolingDown(`groq:model:${model}`)) continue;
      for (const keyIdx of keyOrder) {
        const slotId = `groq:key:${keyIdx}:${model}`;
        if (isCoolingDown(slotId)) continue;
        try {
          const analysis = await runGroqStudy(config.groqApiKeys[keyIdx], model, options);
          setCachedStudy(cacheKey, analysis);
          return { analysis, provider: 'groq', cacheKey };
        } catch (err: unknown) {
          const info = applyHttpCooldown(slotId, err);
          if ((err as Partial<HttpProviderError>)?.status === 404) {
            setCooldown(`groq:model:${model}`, 30 * 60 * 1000);
            break;
          }
          if (info.isRateLimit) {
            sawRateLimit = true;
            if (info.retryAfterSeconds !== null) {
              bestRetryAfter =
                bestRetryAfter === null
                  ? info.retryAfterSeconds
                  : Math.min(bestRetryAfter, info.retryAfterSeconds);
            }
          }
        }
      }
    }
  }

  // Tier 2: Cloudflare Workers AI
  if (config.cfAiBinding || config.cfAiRest) {
    for (const model of config.cfAiModels) {
      const slotId = `cf-ai:${model}`;
      if (isCoolingDown(slotId)) continue;
      try {
        const analysis = await runCloudflareAiStudy(config, model, options);
        setCachedStudy(cacheKey, analysis);
        return { analysis, provider: 'cloudflare-ai', cacheKey };
      } catch (err: unknown) {
        const info = applyHttpCooldown(slotId, err);
        if (info.isRateLimit) {
          sawRateLimit = true;
        }
      }
    }
  }

  // Tier 3: Gemini Flash Lite
  if (config.geminiApiKeys.length > 0) {
    if (config.preferGeminiProxy && config.runGeminiStudyViaProxy) {
      try {
        const proxied = await config.runGeminiStudyViaProxy();
        if (proxied) {
          setCachedStudy(cacheKey, proxied);
          return { analysis: proxied, provider: 'gemini', cacheKey };
        }
      } catch (err: unknown) {
        lastGeminiError = err;
      }
    }

    const keyOrder = rotateIndices(config.geminiApiKeys.length, geminiKeyCursor);
    geminiKeyCursor = (geminiKeyCursor + 1) % config.geminiApiKeys.length;

    for (const keyIdx of keyOrder) {
      const slotId = `gemini:key:${keyIdx}`;
      if (isCoolingDown(slotId)) continue;
      try {
        const ai = getOrCreateGeminiClient(config.geminiApiKeys[keyIdx], config.geminiClients);
        const analysis = await generateStudyAnalysis(ai, options);
        setCachedStudy(cacheKey, analysis);
        return { analysis, provider: 'gemini', cacheKey };
      } catch (err: unknown) {
        lastGeminiError = err;
        const info = inspectGeminiError(err);
        if (info.isRateLimit) {
          sawRateLimit = true;
          setCooldown(slotId, info.isDailyQuota ? 10 * 60 * 1000 : 35_000);
          if (info.retryAfterSeconds !== null) {
            bestRetryAfter =
              bestRetryAfter === null
                ? info.retryAfterSeconds
                : Math.min(bestRetryAfter, info.retryAfterSeconds);
          }
        } else if (info.isAuthError) {
          setCooldown(slotId, 10 * 60 * 1000);
        } else if (info.isLocationUnsupported && config.runGeminiStudyViaProxy) {
          try {
            const proxied = await config.runGeminiStudyViaProxy();
            if (proxied) {
              setCachedStudy(cacheKey, proxied);
              return { analysis: proxied, provider: 'gemini', cacheKey };
            }
          } catch (proxyErr: unknown) {
            lastGeminiError = proxyErr;
          }
          break;
        }
      }
    }
  }

  if (sawRateLimit) {
    const waitText =
      bestRetryAfter && bestRetryAfter <= 90
        ? ` Vui lòng thử lại sau khoảng ${bestRetryAfter} giây.`
        : ' Vui lòng đợi vài giây rồi thử lại.';
    throw new ProviderRouteError(
      `Các nguồn phân tích học bài đang tạm quá tải (429).${waitText}`,
      429,
      bestRetryAfter ?? undefined
    );
  }

  if (lastGeminiError) {
    const mapped = formatGeminiUserError(inspectGeminiError(lastGeminiError), config.envLabel);
    throw new ProviderRouteError(mapped.error, mapped.status, mapped.retryAfterSeconds);
  }

  throw new ProviderRouteError(
    'Không thể phân tích học bài lúc này. Vui lòng thử lại sau giây lát.',
    502
  );
}
