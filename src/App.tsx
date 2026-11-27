import React, { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { Settings } from 'lucide-react';
import { ChatMessage, ChatTheme, MODEL_OPTIONS, ThemePreset, TranslateModelId, TranslationMode } from './types';
import { INITIAL_MESSAGES } from './defaults';
import { useLocalStorage } from './hooks/useLocalStorage';
import { ChatPanel } from './components/ChatPanel';
import { copyTextToClipboard } from './utils/formatters';
import {
  THEME_STORAGE_KEY,
  applyThemeCssVars,
  loadSavedTheme,
  normalizeTheme,
  persistThemeSetting,
} from './utils/color';

const ThemeSettingsModal = lazy(() =>
  import('./components/ThemeSettingsModal').then((m) => ({ default: m.ThemeSettingsModal }))
);

const MESSAGES_STORAGE_KEY = 'cydia_translate_messages_v2';
const MESSAGES_DAY_STORAGE_KEY = 'cydia_translate_messages_day_v1';
const DEFAULT_MODEL_ID: TranslateModelId = 'gemini-3.1-flash-lite';
const VALID_MODEL_IDS = new Set<string>(MODEL_OPTIONS.map((m) => m.id));

function getLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isTimestampFromDateKey(iso: string, dateKey: string): boolean {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return getLocalDateKey(parsed) === dateKey;
}

function purgeExpiredMessagesBeforeHydrate(): void {
  try {
    const todayKey = getLocalDateKey();
    const savedDay = window.localStorage.getItem(MESSAGES_DAY_STORAGE_KEY);
    const rawMessages = window.localStorage.getItem(MESSAGES_STORAGE_KEY);

    if (savedDay && savedDay !== todayKey) {
      window.localStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify([]));
      window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, todayKey);
      return;
    }

    if (rawMessages) {
      const parsed = JSON.parse(rawMessages) as ChatMessage[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const hasExpired = parsed.some((m) => !isTimestampFromDateKey(m.createdAt, todayKey));
        if (hasExpired) {
          window.localStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify([]));
        }
      }
    }

    if (!savedDay) {
      window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, todayKey);
    }
  } catch {
    // Ignore storage access errors in private browsing
  }
}

purgeExpiredMessagesBeforeHydrate();
const INITIAL_SAVED_THEME = loadSavedTheme();
applyThemeCssVars(INITIAL_SAVED_THEME);

function CydiaStarMark() {
  return (
    <img
      src="/assets/aistudio/Logo_robot_1x_435fc3c3.png"
      alt="Cydia Translate logo"
      width={40}
      height={40}
      decoding="async"
      fetchPriority="high"
      referrerPolicy="no-referrer"
      className="w-10 h-10 rounded-full object-cover shrink-0 select-none"
    />
  );
}

export default function App() {
  const [mode, setMode] = useLocalStorage<TranslationMode>('cydia_translate_mode_v2', 'chat');
  const [storedModel, setStoredModel] = useLocalStorage<TranslateModelId>(
    'cydia_translate_model_v1',
    DEFAULT_MODEL_ID
  );
  const [storedTheme, setStoredTheme] = useLocalStorage<ChatTheme>(
    THEME_STORAGE_KEY,
    INITIAL_SAVED_THEME
  );
  const [savedThemes, setSavedThemes] = useLocalStorage<ThemePreset[]>(
    'cydia_translate_saved_themes_v1',
    []
  );
  const [messages, setMessages] = useLocalStorage<ChatMessage[]>(
    MESSAGES_STORAGE_KEY,
    INITIAL_MESSAGES
  );

  const theme = useMemo(() => normalizeTheme(storedTheme), [storedTheme]);

  const handleThemeChange = useCallback(
    (nextTheme: ChatTheme) => {
      const normalized = normalizeTheme(nextTheme);
      applyThemeCssVars(normalized);
      persistThemeSetting(normalized);
      setStoredTheme(normalized);
    },
    [setStoredTheme]
  );

  const handleSaveCustomTheme = useCallback(
    (name: string, targetTheme: ChatTheme) => {
      const cleanName = name.trim() || `Màu #${savedThemes.length + 1}`;
      const normalized = normalizeTheme(targetTheme);
      const nextPreset: ThemePreset = {
        id: `custom-${Date.now()}`,
        name: cleanName,
        theme: normalized,
      };
      setSavedThemes((curr) => [nextPreset, ...curr].slice(0, 8));
    },
    [savedThemes.length, setSavedThemes]
  );

  const handleDeleteCustomTheme = useCallback(
    (presetId: string) => {
      setSavedThemes((curr) => curr.filter((p) => p.id !== presetId));
    },
    [setSavedThemes]
  );

  const selectedModel: TranslateModelId = VALID_MODEL_IDS.has(storedModel)
    ? storedModel
    : DEFAULT_MODEL_ID;

  const handleModelChange = useCallback(
    (nextModel: TranslateModelId) => {
      if (!VALID_MODEL_IDS.has(nextModel)) return;
      setStoredModel(nextModel);
    },
    [setStoredModel]
  );

  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [translatingViId, setTranslatingViId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showThemeSettings, setShowThemeSettings] = useState(false);

  const copyTimerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.id !== 'welcome-msg'),
    [messages]
  );

  useEffect(() => {
    if (!VALID_MODEL_IDS.has(storedModel)) {
      setStoredModel(DEFAULT_MODEL_ID);
    }
  }, [storedModel, setStoredModel]);

  useEffect(() => {
    if (messages.some((m) => m.id === 'welcome-msg')) {
      setMessages((curr) => curr.filter((m) => m.id !== 'welcome-msg'));
    }
  }, [messages, setMessages]);

  // Automatically clear all chat history once the local calendar day ends
  useEffect(() => {
    let midnightTimer: number | null = null;

    const clearIfNewDay = () => {
      const todayKey = getLocalDateKey();
      let savedDay: string | null = null;
      try {
        savedDay = window.localStorage.getItem(MESSAGES_DAY_STORAGE_KEY);
      } catch {
        // Ignore storage errors
      }

      if (savedDay && savedDay !== todayKey) {
        setMessages([]);
      } else {
        setMessages((curr) => {
          if (curr.length === 0) return curr;
          const hasPreviousDayMsg = curr.some((m) => !isTimestampFromDateKey(m.createdAt, todayKey));
          return hasPreviousDayMsg ? [] : curr;
        });
      }

      try {
        window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, todayKey);
      } catch {
        // Ignore storage errors
      }
    };

    const scheduleNextMidnight = () => {
      if (midnightTimer !== null) {
        window.clearTimeout(midnightTimer);
      }
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        1
      );
      const delayMs = Math.max(1000, nextMidnight.getTime() - now.getTime());
      midnightTimer = window.setTimeout(() => {
        clearIfNewDay();
        scheduleNextMidnight();
      }, delayMs);
    };

    clearIfNewDay();
    scheduleNextMidnight();

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        clearIfNewDay();
        scheduleNextMidnight();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);

    return () => {
      if (midnightTimer !== null) {
        window.clearTimeout(midnightTimer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
    };
  }, [setMessages]);

  useEffect(() => {
    applyThemeCssVars(theme);
    persistThemeSetting(theme);
  }, [theme]);

  // Silently warm up Worker / US region proxy & TLS connection while user types first message
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/ping', { method: 'GET', keepalive: true }).catch(() => {});
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    let rafId = 0;

    const syncViewport = () => {
      cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        const vv = window.visualViewport;
        if (vv) {
          root.style.setProperty('--app-vh', `${Math.round(vv.height)}px`);
          root.style.setProperty('--app-offset-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
        } else {
          root.style.setProperty('--app-vh', `${window.innerHeight}px`);
          root.style.setProperty('--app-offset-top', '0px');
        }
        if (window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
      });
    };

    syncViewport();

    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncViewport);
    vv?.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);

    return () => {
      cancelAnimationFrame(rafId);
      vv?.removeEventListener('resize', syncViewport);
      vv?.removeEventListener('scroll', syncViewport);
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
    };
  }, []);

  const triggerCopy = useCallback(async (messageId: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopiedMessageId(messageId);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedMessageId((prev) => (prev === messageId ? null : prev));
      copyTimerRef.current = null;
    }, 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setMessages((curr) =>
      curr.filter((m) => !(m.role === 'assistant' && m.text.trim() === ''))
    );
    setStreamingMessageId(null);
    setIsLoading(false);
  }, [setMessages]);

  const streamTranslation = useCallback(
    async (
      text: string,
      targetMode: TranslationMode,
      targetModel: TranslateModelId,
      messageId: string,
      regenerate: boolean,
      signal: AbortSignal
    ): Promise<
      | { ok: true; translation: string }
      | { ok: false; error: string; aborted?: boolean }
    > => {
      const fetchOnce = () =>
        fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            text,
            mode: targetMode,
            model: targetModel,
            regenerate,
          }),
        });

      const isHtmlResponse = (response: Response) => {
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        return contentType.includes('text/html') || response.headers.get('x-cydia-translate') !== '1';
      };

      let accumulated = '';

      try {
        let res = await fetchOnce();

        if (res.ok && isHtmlResponse(res)) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          res = await fetchOnce();
        }

        if (res.status === 429) {
          const retryAfterHeader = Number(res.headers.get('retry-after') || '0');
          if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 && retryAfterHeader <= 5) {
            await new Promise((resolve) => window.setTimeout(resolve, retryAfterHeader * 1000));
            res = await fetchOnce();
          }
        }

        if (!res.ok) {
          let errMsg = 'Không thể dịch lúc này. Thử lại nhé.';
          const contentType = (res.headers.get('content-type') || '').toLowerCase();
          if (contentType.includes('application/json')) {
            try {
              const errJson = (await res.json()) as { error?: string };
              if (errJson.error) errMsg = errJson.error;
            } catch {
              // Keep default message
            }
          }
          return { ok: false, error: errMsg };
        }

        if (isHtmlResponse(res)) {
          return {
            ok: false,
            error: 'Máy chủ đang khởi động lại, bạn bấm Thử lại sau 1 giây nhé.',
          };
        }

        if (!res.body) {
          const fallbackText = (await res.text()).trim();
          if (!fallbackText || /^<!doctype\s+html/i.test(fallbackText)) {
            return { ok: false, error: 'Không nhận được kết quả dịch. Thử lại nhé.' };
          }
          setMessages((curr) =>
            curr.map((m) => (m.id === messageId ? { ...m, text: fallbackText } : m))
          );
          return { ok: true, translation: fallbackText };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) {
            accumulated += chunk;
            const liveText = accumulated.trimStart();
            if (/^<!doctype\s+html|^<html[\s>]/i.test(liveText)) {
              return {
                ok: false,
                error: 'Máy chủ đang khởi động lại, bạn bấm Thử lại sau 1 giây nhé.',
              };
            }
            setMessages((curr) =>
              curr.map((m) => (m.id === messageId ? { ...m, text: liveText } : m))
            );
          }
        }

        const finalChunk = decoder.decode();
        if (finalChunk) {
          accumulated += finalChunk;
        }

        const cleanFinal = accumulated.trim();
        if (!cleanFinal || /^<!doctype\s+html|^<html[\s>]/i.test(cleanFinal)) {
          return { ok: false, error: 'Không nhận được kết quả dịch. Thử lại nhé.' };
        }

        setMessages((curr) =>
          curr.map((m) => (m.id === messageId ? { ...m, text: cleanFinal } : m))
        );
        return { ok: true, translation: cleanFinal };
      } catch (err: unknown) {
        if (signal.aborted || (err as { name?: string })?.name === 'AbortError') {
          const partial = accumulated.trim();
          if (partial) {
            return { ok: true, translation: partial };
          }
          return { ok: false, error: '', aborted: true };
        }
        return {
          ok: false,
          error: 'Mất kết nối máy chủ. Kiểm tra mạng rồi thử lại nhé.',
        };
      }
    },
    [setMessages]
  );

  const handleSend = useCallback(
    async (text: string) => {
      const nowIso = new Date().toISOString();
      const activeMode = mode;
      const activeModel = selectedModel;
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        text,
        createdAt: nowIso,
      };
      const assistantId = `a-${Date.now() + 1}`;
      const placeholderMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        text: '',
        createdAt: nowIso,
        mode: activeMode,
        model: activeModel,
        sourceText: text,
      };

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setMessages((curr) => [...curr.filter((m) => m.id !== 'welcome-msg'), userMsg, placeholderMsg]);
      setIsLoading(true);
      setStreamingMessageId(assistantId);

      const result = await streamTranslation(
        text,
        activeMode,
        activeModel,
        assistantId,
        false,
        controller.signal
      );
      const finishIso = new Date().toISOString();

      if (result.ok) {
        setMessages((curr) =>
          curr.map((m) =>
            m.id === assistantId
              ? { ...m, text: result.translation, createdAt: finishIso, isError: false }
              : m
          )
        );
        void triggerCopy(assistantId, result.translation);
      } else if (result.aborted) {
        setMessages((curr) => curr.filter((m) => m.id !== assistantId));
      } else {
        setMessages((curr) =>
          curr.map((m) =>
            m.id === assistantId
              ? { ...m, text: result.error, createdAt: finishIso, isError: true }
              : m
          )
        );
      }

      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setStreamingMessageId(null);
        setIsLoading(false);
      }
    },
    [mode, selectedModel, setMessages, streamTranslation, triggerCopy]
  );

  const handleRegenerate = useCallback(
    async (messageId: string, sourceText: string) => {
      if (isLoading) return;
      const activeMode = mode;
      const activeModel = selectedModel;
      const existing = messages.find((m) => m.id === messageId);
      const isRetryFromError = Boolean(existing?.isError);

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setMessages((curr) =>
        curr.map((m) =>
          m.id === messageId
            ? { ...m, text: '', mode: activeMode, model: activeModel, isError: false }
            : m
        )
      );
      setIsLoading(true);
      setStreamingMessageId(messageId);

      const result = await streamTranslation(
        sourceText,
        activeMode,
        activeModel,
        messageId,
        !isRetryFromError,
        controller.signal
      );
      const finishIso = new Date().toISOString();

      if (result.ok) {
        setMessages((curr) =>
          curr.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  text: result.translation,
                  mode: activeMode,
                  model: activeModel,
                  createdAt: finishIso,
                  isError: false,
                }
              : m
          )
        );
        void triggerCopy(messageId, result.translation);
      } else if (result.aborted) {
        setMessages((curr) => curr.filter((m) => m.id !== messageId));
      } else {
        setMessages((curr) =>
          curr.map((m) =>
            m.id === messageId
              ? { ...m, text: result.error, createdAt: finishIso, isError: true }
              : m
          )
        );
      }

      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setStreamingMessageId(null);
        setIsLoading(false);
      }
    },
    [isLoading, messages, mode, selectedModel, setMessages, streamTranslation, triggerCopy]
  );

  const handleTranslateToVi = useCallback(
    async (messageId: string) => {
      if (isLoading || translatingViId !== null) return;
      const target = messages.find((m) => m.id === messageId);
      if (!target || target.isError || !target.text.trim()) return;

      if (target.viTranslation && !target.viError) {
        setMessages((curr) =>
          curr.map((m) =>
            m.id === messageId ? { ...m, showViTranslation: !m.showViTranslation } : m
          )
        );
        return;
      }

      setTranslatingViId(messageId);
      setMessages((curr) =>
        curr.map((m) =>
          m.id === messageId
            ? { ...m, showViTranslation: true, viTranslation: '', viError: undefined }
            : m
        )
      );

      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: target.text,
            mode: target.mode ?? mode,
            model: selectedModel,
            targetLang: 'vi',
          }),
        });

        if (!res.ok) {
          let errMsg = 'Không thể dịch sang tiếng Việt lúc này.';
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/json')) {
            try {
              const errJson = (await res.json()) as { error?: string };
              if (errJson.error) errMsg = errJson.error;
            } catch {
              // Keep default message
            }
          }
          setMessages((curr) =>
            curr.map((m) => (m.id === messageId ? { ...m, viError: errMsg } : m))
          );
          return;
        }

        const viText = (await res.text()).trim();
        if (!viText || /^<!doctype\s+html|^<html[\s>]/i.test(viText)) {
          setMessages((curr) =>
            curr.map((m) =>
              m.id === messageId
                ? { ...m, viError: 'Không nhận được bản dịch tiếng Việt.' }
                : m
            )
          );
          return;
        }

        setMessages((curr) =>
          curr.map((m) =>
            m.id === messageId
              ? { ...m, viTranslation: viText, viError: undefined, showViTranslation: true }
              : m
          )
        );
      } catch {
        setMessages((curr) =>
          curr.map((m) =>
            m.id === messageId
              ? { ...m, viError: 'Mất kết nối máy chủ. Thử lại nhé.' }
              : m
          )
        );
      } finally {
        setTranslatingViId(null);
      }
    },
    [isLoading, messages, mode, selectedModel, setMessages, translatingViId]
  );

  const handleClearChat = () => {
    setMessages([]);
    try {
      window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, getLocalDateKey());
    } catch {
      // Ignore storage errors
    }
  };

  return (
    <div className="fixed inset-x-0 top-[var(--app-offset-top)] h-[var(--app-vh)] w-full bg-[#F2F2F4] flex justify-center overflow-hidden">
      <div className="w-full max-w-[960px] h-full bg-white flex flex-col sm:border-x border-[#E8E8EB] overflow-hidden">
        <header className="bg-white border-b border-[#EFEFF1] pt-[env(safe-area-inset-top)] shrink-0 z-10">
          <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-[60px] sm:h-[64px]">
            <div className="flex items-center gap-3 min-w-0">
              <CydiaStarMark />
              <h1 className="text-[17px] font-semibold tracking-tight text-[#111111] whitespace-nowrap truncate">
                Cydia Translate
              </h1>
            </div>

            <button
              type="button"
              onClick={() => setShowThemeSettings(true)}
              aria-label="Cài đặt"
              title="Cài đặt"
              className="flex items-center justify-center w-10 h-10 rounded-full text-[#52525B] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#111111]"
            >
              <Settings className="w-5 h-5" strokeWidth={1.9} />
            </button>
          </div>
        </header>

        <ChatPanel
          messages={visibleMessages}
          isLoading={isLoading}
          streamingMessageId={streamingMessageId}
          translatingViId={translatingViId}
          copiedMessageId={copiedMessageId}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          onCopyMessage={triggerCopy}
          onSend={handleSend}
          onStop={handleStop}
          onRegenerate={handleRegenerate}
          onTranslateToVi={handleTranslateToVi}
        />
      </div>

      {showThemeSettings && (
        <Suspense fallback={null}>
          <ThemeSettingsModal
            isOpen={showThemeSettings}
            mode={mode}
            theme={theme}
            savedThemes={savedThemes}
            onModeChange={setMode}
            onThemeChange={handleThemeChange}
            onSaveCustomTheme={handleSaveCustomTheme}
            onDeleteCustomTheme={handleDeleteCustomTheme}
            onClearChat={handleClearChat}
            onClose={() => setShowThemeSettings(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
