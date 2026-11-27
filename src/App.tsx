import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Settings } from 'lucide-react';
import { ChatMessage, ChatTheme, TranslateModelId, TranslationMode } from './types';
import { DEFAULT_THEME, INITIAL_MESSAGES } from './defaults';
import { useLocalStorage } from './hooks/useLocalStorage';
import { ChatPanel } from './components/ChatPanel';
import { ThemeSettingsModal } from './components/ThemeSettingsModal';
import { copyTextToClipboard } from './utils/formatters';
import { applyThemeCssVars } from './utils/color';

function CydiaStarMark() {
  return (
    <img
      src="/assets/aistudio/Logo_robot_1x_435fc3c3.png"
      alt="Cydia Translate logo"
      referrerPolicy="no-referrer"
      className="w-10 h-10 rounded-full object-cover shrink-0 select-none"
    />
  );
}

export default function App() {
  const [mode, setMode] = useLocalStorage<TranslationMode>('cydia_translate_mode_v2', 'chat');
  const [selectedModel, setSelectedModel] = useLocalStorage<TranslateModelId>(
    'cydia_translate_model_v1',
    'gemini-3.1-flash-lite'
  );
  const [theme, setTheme] = useLocalStorage<ChatTheme>('cydia_translate_theme_v1', DEFAULT_THEME);
  const [messages, setMessages] = useLocalStorage<ChatMessage[]>(
    'cydia_translate_messages_v2',
    INITIAL_MESSAGES
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
    if (messages.some((m) => m.id === 'welcome-msg')) {
      setMessages((curr) => curr.filter((m) => m.id !== 'welcome-msg'));
    }
  }, [messages, setMessages]);

  useEffect(() => {
    applyThemeCssVars(theme);
  }, [theme]);

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

  const handleClearChat = () => {
    setMessages([]);
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
          onModelChange={setSelectedModel}
          onCopyMessage={triggerCopy}
          onSend={handleSend}
          onStop={handleStop}
          onRegenerate={handleRegenerate}
          onTranslateToVi={handleTranslateToVi}
        />
      </div>

      <ThemeSettingsModal
        isOpen={showThemeSettings}
        mode={mode}
        theme={theme}
        onModeChange={setMode}
        onThemeChange={setTheme}
        onClearChat={handleClearChat}
        onClose={() => setShowThemeSettings(false)}
      />
    </div>
  );
}
