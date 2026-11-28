import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  Languages,
  Loader2,
  Mic,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import { ChatMessage, SpeechHighlightRange, VoiceGender } from '../types';
import { useVoiceInput } from '../hooks/useVoiceInput';
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
  voiceSilenceSeconds: number;
  onCopyMessage: (messageId: string, text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: (messageId: string, sourceText: string) => void;
  onTranslateToVi: (messageId: string) => void;
  onOpenStudy: (messageId: string) => void;
  onSpeak: (key: string, text: string, mode?: 'chat' | 'formal') => void;
  onBeforeStartVoice?: () => void;
  onOpenLiveTalk: () => void;
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
  voiceSilenceSeconds,
  onCopyMessage,
  onSend,
  onStop,
  onRegenerate,
  onTranslateToVi,
  onOpenStudy,
  onSpeak,
  onBeforeStartVoice,
  onOpenLiveTalk,
}: ChatPanelProps) {
  const [input, setInput] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevVoiceStatusRef = useRef<'idle' | 'listening' | 'transcribing'>('idle');

  const voice = useVoiceInput({
    silenceTimeoutMs: Math.round(voiceSilenceSeconds * 1000),
    onBeforeStart: onBeforeStartVoice,
    onTranscriptChange: (mergedText) => {
      setInput(mergedText);
    },
  });

  useEffect(() => {
    const prev = prevVoiceStatusRef.current;
    prevVoiceStatusRef.current = voice.status;
    if (prev !== 'idle' && voice.status === 'idle') {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        try {
          el.setSelectionRange(len, len);
        } catch {
          // Ignore selection errors on unsupported inputs
        }
      }
    }
  }, [voice.status]);

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

  const handleOpenLiveTalk = () => {
    if (voice.status === 'listening') {
      voice.stopListening();
    }
    if (voice.error) {
      voice.clearError();
    }
    onOpenLiveTalk();
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (voice.status === 'listening') {
      voice.stopListening();
    }
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
                    className="max-w-[82%] sm:max-w-[74%] bg-[var(--cydia-user-bg)] text-[var(--cydia-user-text)] px-4 py-3 rounded-[20px] rounded-br-[6px] text-[length:var(--cydia-chat-font-size)] leading-[1.55] whitespace-pre-wrap break-words cursor-pointer hover:opacity-95 active:scale-[0.99] transition-[opacity,transform,background-color]"
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
                      className={`max-w-[84%] sm:max-w-[78%] px-4 py-3 rounded-[20px] rounded-bl-[6px] text-[length:var(--cydia-chat-font-size)] leading-[1.55] whitespace-pre-wrap break-words transition-[opacity,transform,border-color,background-color] duration-150 ${
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
                          className="mt-2.5 pt-2 border-t border-[var(--cydia-bot-border)] text-[length:calc(var(--cydia-chat-font-size)-1px)] leading-[1.5] cursor-text"
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

      {/* Minimal bottom composer with paste, voice dictation, and Send/Stop button */}
      <div className="bg-white border-t border-[#EFEFF1] px-3 sm:px-6 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
        {voice.status === 'transcribing' && (
          <div
            role="status"
            aria-live="polite"
            className="mb-2 px-3 flex items-center gap-2 text-[12.5px] text-[#52525B]"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--cydia-accent)] shrink-0" />
            <span>Đang chuyển giọng nói thành chữ...</span>
          </div>
        )}

        {voice.status === 'idle' && voice.error && (
          <div role="alert" className="mb-1.5 px-3 text-[12px] text-red-600">
            {voice.error}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className={`relative flex items-end gap-1.5 bg-[#F4F4F5] rounded-[28px] pl-1.5 pr-1.5 py-1.5 transition-shadow ${
            voice.status === 'listening'
              ? 'ring-[1.5px] ring-[var(--cydia-accent)]/45 bg-white'
              : ''
          }`}
        >
          <button
            type="button"
            onClick={handleOpenLiveTalk}
            aria-label="Trò chuyện luyện nói tiếng Anh với robot AI"
            title="Luyện giao tiếp tiếng Anh với AI"
            className="flex items-center justify-center w-10 h-10 rounded-full text-[#52525B] hover:text-[var(--cydia-accent)] hover:bg-black/5 active:scale-95 transition-all shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
          >
            <Bot className="w-[20px] h-[20px]" strokeWidth={1.9} />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => {
              if (voice.status === 'listening') {
                voice.stopListening();
              }
              if (voice.error) {
                voice.clearError();
              }
              setInput(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              window.setTimeout(() => {
                if (window.scrollY !== 0) window.scrollTo(0, 0);
                bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
              }, 120);
            }}
            placeholder={voice.status === 'listening' ? 'Đang nghe bạn nói...' : 'Nhập tin nhắn...'}
            className="flex-1 min-w-0 bg-transparent resize-none py-2.5 pl-1 text-[16px] sm:text-[15px] leading-[1.45] text-[#111111] placeholder:text-[#8E8E93] focus:outline-none max-h-36"
          />

          {voice.isSupported && !isLoading && (
            <button
              type="button"
              disabled={voice.status === 'transcribing'}
              onClick={() => voice.toggleListening(input)}
              aria-label={
                voice.status === 'listening'
                  ? 'Dừng ghi âm giọng nói'
                  : voice.status === 'transcribing'
                  ? 'Đang xử lý giọng nói'
                  : 'Nhập bằng giọng nói (Việt – Anh)'
              }
              title={
                voice.status === 'listening'
                  ? 'Dừng ghi âm'
                  : `Nhập bằng giọng nói (tự dừng sau ${Number(voiceSilenceSeconds.toFixed(1))}s im lặng)`
              }
              className={`relative flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-all duration-150 active:scale-95 cursor-pointer disabled:opacity-60 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
                voice.status === 'listening'
                  ? 'bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)]'
                  : 'text-[#52525B] hover:text-[#111111] hover:bg-black/5'
              }`}
            >
              {voice.status === 'listening' && (
                <span
                  aria-hidden="true"
                  className="mic-pulse-ring pointer-events-none absolute inset-0 rounded-full bg-[var(--cydia-accent)]"
                />
              )}
              {voice.status === 'transcribing' ? (
                <Loader2 className="relative w-[18px] h-[18px] animate-spin" strokeWidth={2} />
              ) : voice.status === 'listening' ? (
                <Square className="relative w-3.5 h-3.5 fill-current" strokeWidth={2} />
              ) : (
                <Mic className="relative w-[19px] h-[19px]" strokeWidth={1.9} />
              )}
            </button>
          )}

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
              disabled={!input.trim() || voice.status === 'transcribing'}
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
