import React, { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { Bookmark, Settings } from 'lucide-react';
import {
  ChatMessage,
  ChatTheme,
  SavedLesson,
  SpeechHighlightRange,
  SpeechWordTiming,
  StudyAnalysis,
  ThemePreset,
  TranslationMode,
  VoiceGender,
} from './types';
import { INITIAL_MESSAGES } from './defaults';
import { useLocalStorage } from './hooks/useLocalStorage';
import { ChatPanel } from './components/ChatPanel';
import { copyTextToClipboard } from './utils/formatters';
import {
  createPlayableAudioUrl,
  speakWithBrowserVoice,
  stopBrowserVoice,
} from './utils/audio';
import { alignTimingsToText, findActiveWordRange } from './utils/speechHighlight';
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

const StudyModal = lazy(() =>
  import('./components/StudyModal').then((m) => ({ default: m.StudyModal }))
);

const SavedLessonsModal = lazy(() =>
  import('./components/SavedLessonsModal').then((m) => ({ default: m.SavedLessonsModal }))
);

const DEFAULT_MODE: TranslationMode = 'formal';
const VOICE_STORAGE_KEY = 'cydia_translate_voice_v1';
const VOICE_COOKIE_KEY = 'cydia_voice_v1';
const MESSAGES_STORAGE_KEY = 'cydia_translate_messages_v2';
const MESSAGES_DAY_STORAGE_KEY = 'cydia_translate_messages_day_v1';
const SAVED_LESSONS_STORAGE_KEY = 'cydia_translate_saved_lessons_v1';

interface ActiveStudyView {
  messageId?: string;
  lessonId?: string;
  sourceText: string;
  translatedText: string;
  mode: TranslationMode;
  data: StudyAnalysis | null;
}

function normalizeVoiceGender(raw: unknown): VoiceGender {
  return raw === 'male' ? 'male' : 'female';
}

function readVoiceCookie(): VoiceGender | null {
  try {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${VOICE_COOKIE_KEY}=`));
    if (!match) return null;
    const decoded = decodeURIComponent(match.slice(VOICE_COOKIE_KEY.length + 1)).trim();
    if (decoded === 'male' || decoded === 'female') return decoded;
    return null;
  } catch {
    return null;
  }
}

function persistVoiceSetting(nextVoice: VoiceGender): void {
  const safe = normalizeVoiceGender(nextVoice);
  try {
    window.localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // Ignore storage quota errors
  }
  try {
    document.cookie = `${VOICE_COOKIE_KEY}=${encodeURIComponent(safe)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // Ignore cookie errors
  }
}

function loadSavedVoiceGender(): VoiceGender {
  try {
    const raw = window.localStorage.getItem(VOICE_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === 'male' || parsed === 'female') return parsed;
      } catch {
        const trimmed = raw.trim();
        if (trimmed === 'male' || trimmed === 'female') return trimmed;
      }
    }
  } catch {
    // Fall through to cookie backup
  }
  const fromCookie = readVoiceCookie();
  if (fromCookie) {
    persistVoiceSetting(fromCookie);
    return fromCookie;
  }
  return 'female';
}

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
const INITIAL_SAVED_VOICE = loadSavedVoiceGender();
const INITIAL_SAVED_THEME = loadSavedTheme();
applyThemeCssVars(INITIAL_SAVED_THEME);

function CydiaStarMark() {
  return (
    <img
      src="/assets/aistudio/Logo_robot_meme_2x__1__220cb57d.png"
      alt="Cydia Chatbot logo"
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
  const [storedVoiceGender, setStoredVoiceGender] = useLocalStorage<VoiceGender>(
    VOICE_STORAGE_KEY,
    INITIAL_SAVED_VOICE
  );
  const [storedTheme, setStoredTheme] = useLocalStorage<ChatTheme>(
    THEME_STORAGE_KEY,
    INITIAL_SAVED_THEME
  );
  const [savedThemes, setSavedThemes] = useLocalStorage<ThemePreset[]>(
    'cydia_translate_saved_themes_v1',
    []
  );
  // Permanent saved lessons — never cleared by daily 00:00 reset or Clear Chat
  const [savedLessons, setSavedLessons] = useLocalStorage<SavedLesson[]>(
    SAVED_LESSONS_STORAGE_KEY,
    []
  );
  const [messages, setMessages] = useLocalStorage<ChatMessage[]>(
    MESSAGES_STORAGE_KEY,
    INITIAL_MESSAGES
  );

  const [todayKey, setTodayKey] = useState<string>(() => getLocalDateKey());

  const mode: TranslationMode = DEFAULT_MODE;
  const voiceGender = normalizeVoiceGender(storedVoiceGender);
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

  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [translatingViId, setTranslatingViId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showThemeSettings, setShowThemeSettings] = useState(false);
  const [showSavedLessons, setShowSavedLessons] = useState(false);

  const [studyView, setStudyView] = useState<ActiveStudyView | null>(null);
  const [studyLoading, setStudyLoading] = useState(false);
  const [studyError, setStudyError] = useState<string | null>(null);

  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const [loadingSpeechKey, setLoadingSpeechKey] = useState<string | null>(null);
  const [speechHighlight, setSpeechHighlight] = useState<SpeechHighlightRange | null>(null);

  const copyTimerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const studyAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechRafRef = useRef<number | null>(null);
  const ttsCacheRef = useRef<Map<string, { url: string; timings: SpeechWordTiming[] }>>(
    new Map()
  );

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => m.id !== 'welcome-msg' && isTimestampFromDateKey(m.createdAt, todayKey)
      ),
    [messages, todayKey]
  );

  useEffect(() => {
    if (messages.some((m) => m.id === 'welcome-msg')) {
      setMessages((curr) => curr.filter((m) => m.id !== 'welcome-msg'));
    }
  }, [messages, setMessages]);

  // Keep chat history strictly within the current local day; auto-clear right after 00:00
  useEffect(() => {
    let midnightTimer: number | null = null;

    const clearIfNewDay = () => {
      const currentDayKey = getLocalDateKey();
      setTodayKey((prev) => (prev === currentDayKey ? prev : currentDayKey));

      let savedDay: string | null = null;
      try {
        savedDay = window.localStorage.getItem(MESSAGES_DAY_STORAGE_KEY);
      } catch {
        // Ignore storage errors
      }

      if (savedDay && savedDay !== currentDayKey) {
        setMessages([]);
      } else {
        setMessages((curr) => {
          if (curr.length === 0) return curr;
          const hasExpired = curr.some((m) => !isTimestampFromDateKey(m.createdAt, currentDayKey));
          return hasExpired ? [] : curr;
        });
      }

      try {
        window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, currentDayKey);
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
        0,
        50
      );
      const delayMs = Math.max(250, nextMidnight.getTime() - now.getTime());
      midnightTimer = window.setTimeout(() => {
        clearIfNewDay();
        scheduleNextMidnight();
      }, delayMs);
    };

    clearIfNewDay();
    scheduleNextMidnight();

    // Backup periodic check in case the device sleeps across 00:00 and throttles long timers
    const periodicCheck = window.setInterval(clearIfNewDay, 30_000);

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        clearIfNewDay();
        scheduleNextMidnight();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('pageshow', handleVisibilityOrFocus);

    return () => {
      if (midnightTimer !== null) {
        window.clearTimeout(midnightTimer);
      }
      window.clearInterval(periodicCheck);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('pageshow', handleVisibilityOrFocus);
    };
  }, [setMessages]);

  useEffect(() => {
    persistVoiceSetting(voiceGender);
  }, [voiceGender]);

  useEffect(() => {
    applyThemeCssVars(theme);
    persistThemeSetting(theme);
  }, [theme]);

  // Silently warm up Worker / US region proxy
  useEffect(() => {
    const pingTimer = window.setTimeout(() => {
      void fetch('/api/ping', { method: 'GET', keepalive: true }).catch(() => {});
    }, 150);
    return () => {
      window.clearTimeout(pingTimer);
    };
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
      const now = new Date();
      const nowIso = now.toISOString();
      const currentDayKey = getLocalDateKey(now);
      setTodayKey(currentDayKey);
      try {
        window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, currentDayKey);
      } catch {
        // Ignore storage errors
      }

      const activeMode = mode;
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
        sourceText: text,
      };

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setMessages((curr) => [
        ...curr.filter(
          (m) => m.id !== 'welcome-msg' && isTimestampFromDateKey(m.createdAt, currentDayKey)
        ),
        userMsg,
        placeholderMsg,
      ]);
      setIsLoading(true);
      setStreamingMessageId(assistantId);

      const result = await streamTranslation(
        text,
        activeMode,
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
    [mode, setMessages, streamTranslation, triggerCopy]
  );

  const handleRegenerate = useCallback(
    async (messageId: string, sourceText: string) => {
      if (isLoading) return;
      const activeMode = mode;
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
            ? { ...m, text: '', mode: activeMode, isError: false, studyData: undefined }
            : m
        )
      );
      setIsLoading(true);
      setStreamingMessageId(messageId);

      const result = await streamTranslation(
        sourceText,
        activeMode,
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
    [isLoading, messages, mode, setMessages, streamTranslation, triggerCopy]
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
    [isLoading, messages, mode, setMessages, translatingViId]
  );

  const findMatchingSavedLesson = useCallback(
    (sourceText: string, translatedText: string, lessonId?: string): SavedLesson | undefined => {
      if (lessonId) {
        const byId = savedLessons.find((l) => l.id === lessonId);
        if (byId) return byId;
      }
      const normSrc = sourceText.trim().toLowerCase();
      const normTr = translatedText.trim().toLowerCase();
      return savedLessons.find(
        (l) =>
          l.sourceText.trim().toLowerCase() === normSrc &&
          l.translatedText.trim().toLowerCase() === normTr
      );
    },
    [savedLessons]
  );

  const runStudyAnalysis = useCallback(
    async (target: ActiveStudyView, forceRefresh = false) => {
      if (!forceRefresh && target.data) {
        setStudyLoading(false);
        setStudyError(null);
        return;
      }

      if (studyAbortRef.current) {
        studyAbortRef.current.abort();
      }
      const controller = new AbortController();
      studyAbortRef.current = controller;

      setStudyLoading(true);
      setStudyError(null);

      if (forceRefresh) {
        setStudyView((prev) => (prev ? { ...prev, data: null } : prev));
        if (target.messageId) {
          setMessages((curr) =>
            curr.map((m) => (m.id === target.messageId ? { ...m, studyData: undefined } : m))
          );
        }
      }

      try {
        const res = await fetch('/api/study', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            sourceText: target.sourceText,
            translatedText: target.translatedText,
            mode: target.mode,
          }),
        });

        if (!res.ok) {
          let errMsg = 'Không thể phân tích học bài lúc này. Thử lại nhé.';
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/json')) {
            try {
              const errJson = (await res.json()) as { error?: string };
              if (errJson.error) errMsg = errJson.error;
            } catch {
              // Keep default message
            }
          }
          if (studyAbortRef.current === controller) {
            setStudyError(errMsg);
          }
          return;
        }

        const analysis = (await res.json()) as StudyAnalysis;
        if (studyAbortRef.current === controller) {
          setStudyView((prev) => (prev ? { ...prev, data: analysis } : prev));
          if (target.messageId) {
            setMessages((curr) =>
              curr.map((m) => (m.id === target.messageId ? { ...m, studyData: analysis } : m))
            );
          }
          if (target.lessonId) {
            setSavedLessons((curr) =>
              curr.map((l) => (l.id === target.lessonId ? { ...l, data: analysis } : l))
            );
          }
          setStudyError(null);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
          return;
        }
        if (studyAbortRef.current === controller) {
          setStudyError('Mất kết nối máy chủ. Kiểm tra mạng rồi thử lại nhé.');
        }
      } finally {
        if (studyAbortRef.current === controller) {
          studyAbortRef.current = null;
          setStudyLoading(false);
        }
      }
    },
    [setMessages, setSavedLessons]
  );

  const handleOpenStudy = useCallback(
    (messageId: string) => {
      const target = messages.find((m) => m.id === messageId);
      if (!target || target.isError || !target.text.trim()) return;
      const sourceText = target.sourceText || target.text;
      const translatedText = target.text;
      const existingSaved = findMatchingSavedLesson(sourceText, translatedText);
      const nextView: ActiveStudyView = {
        messageId: target.id,
        lessonId: existingSaved?.id,
        sourceText,
        translatedText,
        mode: target.mode ?? mode,
        data: target.studyData ?? existingSaved?.data ?? null,
      };
      setStudyView(nextView);
      void runStudyAnalysis(nextView, false);
    },
    [findMatchingSavedLesson, messages, mode, runStudyAnalysis]
  );

  const handleOpenSavedLesson = useCallback((lesson: SavedLesson) => {
    setShowSavedLessons(false);
    setStudyError(null);
    setStudyLoading(false);
    setStudyView({
      lessonId: lesson.id,
      sourceText: lesson.sourceText,
      translatedText: lesson.translatedText,
      mode: lesson.mode,
      data: lesson.data,
    });
  }, []);

  const handleCloseStudy = useCallback(() => {
    if (studyAbortRef.current) {
      studyAbortRef.current.abort();
      studyAbortRef.current = null;
    }
    setStudyView(null);
    setStudyLoading(false);
    setStudyError(null);
  }, []);

  const activeSavedLesson = useMemo(() => {
    if (!studyView) return undefined;
    return findMatchingSavedLesson(
      studyView.sourceText,
      studyView.translatedText,
      studyView.lessonId
    );
  }, [findMatchingSavedLesson, studyView]);

  const handleToggleSaveCurrentLesson = useCallback(() => {
    if (!studyView || !studyView.data) return;

    if (activeSavedLesson) {
      setSavedLessons((curr) => curr.filter((l) => l.id !== activeSavedLesson.id));
      setStudyView((prev) => (prev ? { ...prev, lessonId: undefined } : prev));
      return;
    }

    const newLesson: SavedLesson = {
      id: `lesson-${Date.now()}`,
      sourceText: studyView.sourceText,
      translatedText: studyView.translatedText,
      mode: studyView.mode,
      data: studyView.data,
      savedAt: new Date().toISOString(),
    };
    setSavedLessons((curr) => [newLesson, ...curr]);
    setStudyView((prev) => (prev ? { ...prev, lessonId: newLesson.id } : prev));
  }, [activeSavedLesson, setSavedLessons, studyView]);

  const handleDeleteSavedLesson = useCallback(
    (lessonId: string) => {
      setSavedLessons((curr) => curr.filter((l) => l.id !== lessonId));
      setStudyView((prev) =>
        prev && prev.lessonId === lessonId ? { ...prev, lessonId: undefined } : prev
      );
    },
    [setSavedLessons]
  );

  const stopSpeechSyncLoop = useCallback(() => {
    if (speechRafRef.current !== null) {
      window.cancelAnimationFrame(speechRafRef.current);
      speechRafRef.current = null;
    }
  }, []);

  const stopSpeech = useCallback(() => {
    stopSpeechSyncLoop();
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    stopBrowserVoice();
    setSpeakingKey(null);
    setLoadingSpeechKey(null);
    setSpeechHighlight(null);
  }, [stopSpeechSyncLoop]);

  const handleVoiceGenderChange = useCallback(
    (nextVoice: VoiceGender) => {
      const safe = normalizeVoiceGender(nextVoice);
      stopSpeech();
      persistVoiceSetting(safe);
      setStoredVoiceGender(safe);
    },
    [setStoredVoiceGender, stopSpeech]
  );

  useEffect(() => {
    const cache = ttsCacheRef.current;
    return () => {
      if (speechRafRef.current !== null) {
        window.cancelAnimationFrame(speechRafRef.current);
      }
      if (ttsAbortRef.current) {
        ttsAbortRef.current.abort();
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      stopBrowserVoice();
      cache.forEach((entry) => URL.revokeObjectURL(entry.url));
      cache.clear();
    };
  }, []);

  const handleSpeak = useCallback(
    async (key: string, text: string, _targetMode?: TranslationMode) => {
      const cleanText = text.trim();
      if (!cleanText) return;

      // Toggle off if already playing or loading the same item
      if (speakingKey === key || loadingSpeechKey === key) {
        stopSpeech();
        return;
      }

      stopSpeech();

      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.setAttribute('playsinline', 'true');
      }
      const audio = audioRef.current;

      const cacheKey = `${voiceGender}:${cleanText}`;
      const cachedEntry = ttsCacheRef.current.get(cacheKey);

      const playWithHighlight = async (url: string, timings: SpeechWordTiming[]) => {
        const aligned = alignTimingsToText(text, timings);
        let lastStart = -1;
        let lastEnd = -1;

        const clearPlayback = () => {
          stopSpeechSyncLoop();
          setSpeakingKey((prev) => (prev === key ? null : prev));
          setSpeechHighlight((prev) => (prev?.key === key ? null : prev));
        };

        const syncFrame = () => {
          if (audio.paused || audio.ended) {
            speechRafRef.current = null;
            return;
          }
          const currentMs = audio.currentTime * 1000;
          const active = findActiveWordRange(aligned, currentMs);
          const nextStart = active ? active.start : -1;
          const nextEnd = active ? active.end : -1;

          if (nextStart !== lastStart || nextEnd !== lastEnd) {
            lastStart = nextStart;
            lastEnd = nextEnd;
            setSpeechHighlight(
              active ? { key, start: active.start, end: active.end } : null
            );
          }
          speechRafRef.current = window.requestAnimationFrame(syncFrame);
        };

        audio.onended = clearPlayback;
        audio.onerror = clearPlayback;
        audio.src = url;
        audio.currentTime = 0;
        setSpeakingKey(key);
        setSpeechHighlight(null);

        try {
          await audio.play();
          if (aligned.length > 0) {
            stopSpeechSyncLoop();
            speechRafRef.current = window.requestAnimationFrame(syncFrame);
          }
        } catch {
          clearPlayback();
        }
      };

      const playBrowserFallback = () => {
        setLoadingSpeechKey(null);
        setSpeakingKey(key);
        setSpeechHighlight(null);
        const leadingSpaces = text.length - text.trimStart().length;
        const clearBrowser = () => {
          setSpeakingKey((prev) => (prev === key ? null : prev));
          setSpeechHighlight((prev) => (prev?.key === key ? null : prev));
        };
        const ok = speakWithBrowserVoice(cleanText, voiceGender, {
          onBoundary: (start, end) => {
            setSpeechHighlight({
              key,
              start: start + leadingSpaces,
              end: end + leadingSpaces,
            });
          },
          onEnd: clearBrowser,
          onError: clearBrowser,
        });
        if (!ok) {
          clearBrowser();
        }
      };

      if (cachedEntry) {
        await playWithHighlight(cachedEntry.url, cachedEntry.timings);
        return;
      }

      // Prime audio element inside the user gesture for iOS Safari autoplay policy
      try {
        audio.load();
      } catch {
        // Ignore load errors
      }

      const controller = new AbortController();
      ttsAbortRef.current = controller;
      setLoadingSpeechKey(key);

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            text: cleanText,
            voiceGender,
          }),
        });

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        let objectUrl = '';
        let timings: SpeechWordTiming[] = [];

        if (res.ok && contentType.includes('application/json')) {
          const data = (await res.json()) as {
            audioBase64?: string;
            mimeType?: string;
            timings?: SpeechWordTiming[];
          };
          if (!data.audioBase64) {
            throw new Error('TTS_EMPTY_AUDIO');
          }
          objectUrl = createPlayableAudioUrl(data.audioBase64, data.mimeType || 'audio/mpeg');
          timings = Array.isArray(data.timings) ? data.timings : [];
        } else if (res.ok && contentType.startsWith('audio/')) {
          const audioBlob = await res.blob();
          if (audioBlob.size === 0) {
            throw new Error('TTS_EMPTY_BLOB');
          }
          objectUrl = URL.createObjectURL(audioBlob);
        } else {
          throw new Error(`TTS_HTTP_${res.status}`);
        }

        if (controller.signal.aborted || ttsAbortRef.current !== controller) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        if (ttsCacheRef.current.size >= 40) {
          const oldestKey = ttsCacheRef.current.keys().next().value;
          if (oldestKey) {
            const oldEntry = ttsCacheRef.current.get(oldestKey);
            if (oldEntry) URL.revokeObjectURL(oldEntry.url);
            ttsCacheRef.current.delete(oldestKey);
          }
        }
        ttsCacheRef.current.set(cacheKey, { url: objectUrl, timings });

        setLoadingSpeechKey(null);
        await playWithHighlight(objectUrl, timings);
      } catch (err: unknown) {
        if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
          return;
        }
        if (ttsAbortRef.current === controller) {
          playBrowserFallback();
        }
      } finally {
        if (ttsAbortRef.current === controller) {
          ttsAbortRef.current = null;
          setLoadingSpeechKey((prev) => (prev === key ? null : prev));
        }
      }
    },
    [loadingSpeechKey, speakingKey, stopSpeech, stopSpeechSyncLoop, voiceGender]
  );

  const handleClearChat = () => {
    stopSpeech();
    handleCloseStudy();
    setMessages([]);
    try {
      window.localStorage.setItem(MESSAGES_DAY_STORAGE_KEY, getLocalDateKey());
    } catch {
      // Ignore storage errors
    }
  };

  return (
    <div className="fixed inset-x-0 top-[var(--app-offset-top)] h-[var(--app-vh)] w-full bg-white flex flex-col overflow-hidden">
      <header className="bg-white border-b border-[#EFEFF1] pt-[env(safe-area-inset-top)] shrink-0 z-10">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-[60px] sm:h-[64px]">
          <div className="flex items-center gap-3 min-w-0">
            <CydiaStarMark />
            <h1 className="min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-1.5 leading-tight">
              <span className="text-[16px] sm:text-[17px] font-semibold tracking-tight text-[#111111] truncate">
                Cydia Chatbot
              </span>
              <span className="hidden sm:inline text-[#A1A1AA] font-normal" aria-hidden="true">
                –
              </span>
              <span className="text-[11.5px] sm:text-[14px] font-medium text-[#71717A] truncate">
                Translate &amp; Learn English
              </span>
            </h1>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setShowSavedLessons(true)}
              aria-label="Bài học đã lưu"
              title="Bài học đã lưu"
              className="inline-flex items-center justify-center gap-1.5 min-w-[40px] h-10 px-2.5 rounded-full text-[#52525B] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#111111]"
            >
              <Bookmark className="w-[19px] h-[19px]" strokeWidth={1.9} />
              {savedLessons.length > 0 && (
                <span className="text-[13px] font-medium tabular-nums text-[#111111]">
                  {savedLessons.length}
                </span>
              )}
            </button>

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
        </div>
      </header>

      <ChatPanel
        messages={visibleMessages}
        isLoading={isLoading}
        streamingMessageId={streamingMessageId}
        translatingViId={translatingViId}
        copiedMessageId={copiedMessageId}
        speakingKey={speakingKey}
        loadingSpeechKey={loadingSpeechKey}
        speechHighlight={speechHighlight}
        voiceGender={voiceGender}
        onCopyMessage={triggerCopy}
        onSend={handleSend}
        onStop={handleStop}
        onRegenerate={handleRegenerate}
        onTranslateToVi={handleTranslateToVi}
        onOpenStudy={handleOpenStudy}
        onSpeak={(key, text, msgMode) => void handleSpeak(key, text, msgMode)}
      />

      {studyView && (
        <Suspense fallback={null}>
          <StudyModal
            isOpen={Boolean(studyView)}
            sourceText={studyView.sourceText}
            translatedText={studyView.translatedText}
            mode={studyView.mode}
            data={studyView.data}
            isLoading={studyLoading}
            error={studyError}
            isSaved={Boolean(activeSavedLesson)}
            speakingKey={speakingKey}
            loadingSpeechKey={loadingSpeechKey}
            speechHighlight={speechHighlight}
            onSpeak={(key, text, targetMode) => void handleSpeak(key, text, targetMode)}
            onToggleSave={handleToggleSaveCurrentLesson}
            onRetry={() => void runStudyAnalysis(studyView, true)}
            onClose={handleCloseStudy}
          />
        </Suspense>
      )}

      {showSavedLessons && (
        <Suspense fallback={null}>
          <SavedLessonsModal
            isOpen={showSavedLessons}
            lessons={savedLessons}
            onSelectLesson={handleOpenSavedLesson}
            onDeleteLesson={handleDeleteSavedLesson}
            onClose={() => setShowSavedLessons(false)}
          />
        </Suspense>
      )}

      {showThemeSettings && (
        <Suspense fallback={null}>
          <ThemeSettingsModal
            isOpen={showThemeSettings}
            voiceGender={voiceGender}
            theme={theme}
            savedThemes={savedThemes}
            onVoiceGenderChange={handleVoiceGenderChange}
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
