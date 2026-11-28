import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowUp,
  BookOpen,
  Check,
  ClipboardPaste,
  Languages,
  Loader2,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import { ChatMessage, SpeechHighlightRange, VoiceGender } from '../types';
import { formatDateGroup, formatTime } from '../utils/formatters';

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingMessageId: string | null;
  translatingViId: string | null;
  copiedMessageId: string | null;
  speakingKey: string | null;
  loadingSpeechKey: string | null;
  speechHighlight: SpeechHighlightRange | null;
  voiceGender: VoiceGender;
  onCopyMessage: (messageId: string, text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: (messageId: string, sourceText: string) => void;
  onTranslateToVi: (messageId: string) => void;
  onOpenStudy: (messageId: string) => void;
  onSpeak: (key: string, text: string, mode?: 'chat' | 'formal') => void;
}

function renderSpeechHighlightedText(
  text: string,
  highlight: SpeechHighlightRange | null
): React.ReactNode {
  if (!highlight) return text;
  const start = Math.max(0, Math.min(text.length, highlight.start));
  const end = Math.max(start, Math.min(text.length, highlight.end));
  if (end <= start) return text;

  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-[var(--cydia-speech-hl-bg)] text-[var(--cydia-speech-hl-text)] rounded-[4px] px-[2px] -mx-[2px] py-[1px] box-decoration-clone">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

export const ChatPanel = React.memo(function ChatPanel({
  messages,
  isLoading,
  streamingMessageId,
  translatingViId,
  copiedMessageId,
  speakingKey,
  loadingSpeechKey,
  speechHighlight,
  voiceGender,
  onCopyMessage,
  onSend,
  onStop,
  onRegenerate,
  onTranslateToVi,
  onOpenStudy,
  onSpeak,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [pasteFeedback, setPasteFeedback] = useState<'pasted' | 'empty' | 'denied' | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pasteTimerRef = useRef<number | null>(null);

  const lastMsgText = messages[messages.length - 1]?.text ?? '';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: streamingMessageId ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [messages.length, lastMsgText, isLoading, streamingMessageId]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    };
    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  useEffect(() => {
    return () => {
      if (pasteTimerRef.current !== null) {
        window.clearTimeout(pasteTimerRef.current);
      }
    };
  }, []);

  const flashPasteFeedback = (status: 'pasted' | 'empty' | 'denied', durationMs = 1500) => {
    setPasteFeedback(status);
    if (pasteTimerRef.current !== null) {
      window.clearTimeout(pasteTimerRef.current);
    }
    pasteTimerRef.current = window.setTimeout(() => {
      setPasteFeedback(null);
      pasteTimerRef.current = null;
    }, durationMs);
  };

  const handlePasteFromClipboard = async () => {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      textareaRef.current?.focus();
      flashPasteFeedback('denied', 2200);
      return;
    }

    try {
      const clipText = (await navigator.clipboard.readText()).trim();
      if (!clipText) {
        textareaRef.current?.focus();
        flashPasteFeedback('empty', 1600);
        return;
      }

      const el = textareaRef.current;
      if (el && document.activeElement === el) {
        const start = el.selectionStart ?? input.length;
        const end = el.selectionEnd ?? input.length;
        const nextVal = `${input.slice(0, start)}${clipText}${input.slice(end)}`;
        setInput(nextVal);
        const caretPos = start + clipText.length;
        window.requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(caretPos, caretPos);
        });
      } else {
        const nextVal = input.trim().length > 0 ? `${input.trimEnd()} ${clipText}` : clipText;
        setInput(nextVal);
        window.requestAnimationFrame(() => {
          if (el) {
            el.focus();
            el.setSelectionRange(nextVal.length, nextVal.length);
          }
        });
      }

      flashPasteFeedback('pasted', 1200);
    } catch {
      textareaRef.current?.focus();
      flashPasteFeedback('denied', 2200);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    setInput('');
    onSend(trimmed);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleBubbleClick = (msg: ChatMessage) => {
    if (msg.isError || msg.id === streamingMessageId) return;
    const selectedText = window.getSelection()?.toString();
    if (selectedText && selectedText.length > 0) return;
    onCopyMessage(msg.id, msg.text);
  };

  const showStandaloneDots =
    isLoading &&
    (!streamingMessageId ||
      messages.find((m) => m.id === streamingMessageId)?.text.trim() === '');

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--cydia-chat-bg)] transition-colors duration-150">
      {/* Scrollable message feed */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 py-5 space-y-5">
        {messages.map((msg, index) => {
          const isStreamingEmpty = msg.id === streamingMessageId && msg.text.trim() === '';
          if (isStreamingEmpty) return null;

          const currentGroup = formatDateGroup(msg.createdAt);
          const prevGroup = index > 0 ? formatDateGroup(messages[index - 1].createdAt) : null;
          const showDateHeader = currentGroup !== prevGroup;
          const isUser = msg.role === 'user';
          const isCopied = copiedMessageId === msg.id;
          const isCurrentlyStreaming = msg.id === streamingMessageId;

          return (
            <div key={msg.id} className="space-y-4">
              {showDateHeader && (
                <div className="flex justify-center pt-1 pb-1">
                  <span className="text-[12px] font-medium text-[var(--cydia-chat-muted)] tracking-tight">
                    {currentGroup}
                  </span>
                </div>
              )}

              {isUser ? (
                <div className="flex flex-col items-end">
                  <div
                    role="button"
                    tabIndex={0}
                    title="Bấm để copy"
                    onClick={() => handleBubbleClick(msg)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleBubbleClick(msg);
                      }
                    }}
                    className="max-w-[82%] sm:max-w-[74%] bg-[var(--cydia-user-bg)] text-[var(--cydia-user-text)] px-4 py-3 rounded-[20px] rounded-br-[6px] text-[15px] leading-[1.55] whitespace-pre-wrap break-words cursor-pointer hover:opacity-95 active:scale-[0.99] transition-all"
                  >
                    {msg.text}
                  </div>
                  <div className="mt-1.5 mr-1 flex items-center gap-1.5 text-[11px] text-[var(--cydia-chat-muted)] tabular-nums">
                    {isCopied && (
                      <>
                        <span className="inline-flex items-center gap-0.5 text-[var(--cydia-chat-strong)] font-medium">
                          <Check className="w-3 h-3" strokeWidth={2.4} />
                          Đã copy
                        </span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span>{formatTime(msg.createdAt)}</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-start">
                  <div className="flex items-end gap-2 max-w-full">
                    <div
                      role={!msg.isError ? 'button' : undefined}
                      tabIndex={!msg.isError ? 0 : undefined}
                      title={!msg.isError ? 'Bấm vào tin nhắn để copy' : undefined}
                      onClick={() => handleBubbleClick(msg)}
                      onKeyDown={(e) => {
                        if (!msg.isError && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          handleBubbleClick(msg);
                        }
                      }}
                      className={`max-w-[84%] sm:max-w-[78%] px-4 py-3 rounded-[20px] rounded-bl-[6px] text-[15px] leading-[1.55] whitespace-pre-wrap break-words transition-all duration-150 ${
                        msg.isError
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : isCopied
                          ? 'bg-[var(--cydia-bot-bg)] text-[var(--cydia-bot-text)] border border-[var(--cydia-accent)] cursor-pointer'
                          : 'bg-[var(--cydia-bot-bg)] text-[var(--cydia-bot-text)] border border-[var(--cydia-bot-border)] hover:opacity-95 active:scale-[0.99] cursor-pointer'
                      }`}
                    >
                      <div>
                        {renderSpeechHighlightedText(
                          msg.text,
                          speechHighlight?.key === `msg-${msg.id}` ? speechHighlight : null
                        )}
                      </div>

                      {msg.showViTranslation && (msg.viTranslation || msg.viError || translatingViId === msg.id) && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="mt-2.5 pt-2 border-t border-[var(--cydia-bot-border)] text-[14px] leading-[1.5] cursor-text"
                        >
                          {msg.viError ? (
                            <span className="text-red-600 text-[13px]">{msg.viError}</span>
                          ) : msg.viTranslation ? (
                            <span className="italic opacity-80">{msg.viTranslation}</span>
                          ) : (
                            <span className="italic opacity-50 text-[13px]">Đang dịch sang tiếng Việt...</span>
                          )}
                        </div>
                      )}
                    </div>

                    {!msg.isError && !isCurrentlyStreaming && msg.text.trim().length > 0 && (
                      <div className="flex items-center gap-0.5 shrink-0 pb-0.5">
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => onSpeak(`msg-${msg.id}`, msg.text, msg.mode)}
                          aria-label={
                            speakingKey === `msg-${msg.id}`
                              ? 'Dừng phát giọng đọc'
                              : voiceGender === 'male'
                              ? 'Nghe phát âm giọng nam bản xứ'
                              : 'Nghe phát âm giọng nữ bản xứ'
                          }
                          title={
                            speakingKey === `msg-${msg.id}`
                              ? 'Dừng đọc'
                              : voiceGender === 'male'
                              ? 'Nghe phát âm giọng nam bản xứ'
                              : 'Nghe phát âm giọng nữ bản xứ'
                          }
                          className={`inline-flex items-center justify-center min-h-[38px] min-w-[38px] rounded-full border border-transparent transition-all duration-150 disabled:opacity-40 cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
                            speakingKey === `msg-${msg.id}`
                              ? 'text-[var(--cydia-accent)] bg-black/5'
                              : 'text-[var(--cydia-chat-muted)] hover:text-[var(--cydia-chat-strong)] hover:bg-black/5'
                          }`}
                        >
                          {loadingSpeechKey === `msg-${msg.id}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                          ) : (
                            <Volume2
                              className={`w-3.5 h-3.5 ${
                                speakingKey === `msg-${msg.id}` ? 'animate-pulse' : ''
                              }`}
                              strokeWidth={2}
                            />
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={isLoading || (translatingViId !== null && translatingViId !== msg.id)}
                          onClick={() => onTranslateToVi(msg.id)}
                          aria-label="Dịch sang tiếng Việt"
                          title={
                            msg.showViTranslation && msg.viTranslation
                              ? 'Ẩn bản dịch tiếng Việt'
                              : 'Dịch sang tiếng Việt'
                          }
                          className={`inline-flex items-center justify-center min-h-[38px] min-w-[38px] rounded-full border border-transparent transition-all duration-150 disabled:opacity-40 cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
                            msg.showViTranslation && msg.viTranslation
                              ? 'text-[var(--cydia-chat-strong)] bg-black/5'
                              : 'text-[var(--cydia-chat-muted)] hover:text-[var(--cydia-chat-strong)] hover:bg-black/5'
                          }`}
                        >
                          {translatingViId === msg.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                          ) : (
                            <Languages className="w-3.5 h-3.5" strokeWidth={1.9} />
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => onOpenStudy(msg.id)}
                          aria-label="Học bài: phân tích ngữ pháp & cách dùng"
                          title="Học bài: sửa lỗi, ngữ cảnh & câu thay thế"
                          className={`inline-flex items-center justify-center min-h-[38px] min-w-[38px] rounded-full border border-transparent transition-all duration-150 disabled:opacity-40 cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
                            msg.studyData
                              ? 'text-[var(--cydia-chat-strong)] bg-black/5'
                              : 'text-[var(--cydia-chat-muted)] hover:text-[var(--cydia-chat-strong)] hover:bg-black/5'
                          }`}
                        >
                          <BookOpen className="w-3.5 h-3.5" strokeWidth={1.9} />
                        </button>
                      </div>
                    )}

                    {msg.isError && msg.sourceText && (
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={() => onRegenerate(msg.id, msg.sourceText!)}
                        className="inline-flex items-center gap-1.5 min-h-[38px] px-3 rounded-full border border-red-200 bg-white text-[12px] font-medium text-red-700 hover:bg-red-50 transition-colors cursor-pointer shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span className="whitespace-nowrap">Thử lại</span>
                      </button>
                    )}
                  </div>

                  <div className="mt-1.5 ml-1 flex items-center gap-1.5 text-[11px] text-[var(--cydia-chat-muted)] tabular-nums">
                    <span>{formatTime(msg.createdAt)}</span>
                    {msg.mode && !msg.isError && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{msg.mode === 'formal' ? 'Formal' : 'Chat'}</span>
                      </>
                    )}
                    {isCopied && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-0.5 text-[var(--cydia-chat-strong)] font-medium">
                          <Check className="w-3 h-3" strokeWidth={2.4} />
                          Đã copy
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {showStandaloneDots && (
          <div className="flex flex-col items-start">
            <div className="inline-flex items-center gap-1.5 bg-[var(--cydia-bot-bg)] border border-[var(--cydia-bot-border)] px-4 py-3.5 rounded-[20px] rounded-bl-[6px]">
              <span className="typing-dot w-2 h-2 rounded-full bg-[var(--cydia-bot-text)]" />
              <span className="typing-dot w-2 h-2 rounded-full bg-[var(--cydia-bot-text)] opacity-60" />
              <span className="typing-dot w-2 h-2 rounded-full bg-[var(--cydia-bot-text)] opacity-35" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Minimal bottom composer with paste button & Send/Stop button */}
      <div className="bg-white border-t border-[#EFEFF1] px-3 sm:px-6 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
        {(pasteFeedback === 'empty' || pasteFeedback === 'denied') && (
          <div className="mb-1.5 px-3 text-[12px] text-[#71717A]">
            {pasteFeedback === 'empty'
              ? 'Clipboard hiện đang trống.'
              : 'Trình duyệt chặn đọc clipboard — hãy chạm giữ ô nhập để dán.'}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="relative flex items-end gap-1.5 bg-[#F4F4F5] rounded-[28px] pl-1.5 pr-1.5 py-1.5"
        >
          <button
            type="button"
            onClick={() => void handlePasteFromClipboard()}
            aria-label="Dán từ clipboard"
            title="Dán từ clipboard"
            className="flex items-center justify-center w-10 h-10 rounded-full text-[#52525B] hover:text-[#111111] hover:bg-black/5 active:scale-95 transition-all shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
          >
            {pasteFeedback === 'pasted' ? (
              <Check className="w-4 h-4 text-emerald-600" strokeWidth={2.3} />
            ) : (
              <ClipboardPaste className="w-[18px] h-[18px]" strokeWidth={1.9} />
            )}
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              window.setTimeout(() => {
                if (window.scrollY !== 0) window.scrollTo(0, 0);
                bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
              }, 120);
            }}
            placeholder="Nhập tin nhắn..."
            className="flex-1 min-w-0 bg-transparent resize-none py-2.5 pl-1 text-[16px] sm:text-[15px] leading-[1.45] text-[#111111] placeholder:text-[#8E8E93] focus:outline-none max-h-36"
          />

          {isLoading ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Dừng dịch"
              title="Dừng"
              className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] shrink-0 transition-all duration-150 hover:opacity-90 active:scale-95 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
            >
              <Square className="w-3.5 h-3.5 fill-current" strokeWidth={2} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Gửi tin nhắn"
              title="Gửi"
              className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] shrink-0 transition-all duration-150 hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
            >
              <ArrowUp className="w-5 h-5" strokeWidth={2.2} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
});
