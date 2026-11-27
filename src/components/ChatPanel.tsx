import React, { useState, useRef, useEffect } from 'react';
import { ArrowUp, Check, Languages, Loader2, RotateCcw } from 'lucide-react';
import { ChatMessage } from '../types';
import { formatDateGroup, formatTime } from '../utils/formatters';

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingMessageId: string | null;
  translatingViId: string | null;
  copiedMessageId: string | null;
  onCopyMessage: (messageId: string, text: string) => void;
  onSend: (text: string) => void;
  onRegenerate: (messageId: string, sourceText: string) => void;
  onTranslateToVi: (messageId: string) => void;
}

export function ChatPanel({
  messages,
  isLoading,
  streamingMessageId,
  translatingViId,
  copiedMessageId,
  onCopyMessage,
  onSend,
  onRegenerate,
  onTranslateToVi,
}: ChatPanelProps) {
  const [input, setInput] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lastMsgText = messages[messages.length - 1]?.text ?? '';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, lastMsgText, isLoading]);

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
                      <div>{msg.text}</div>

                      {msg.showViTranslation && (msg.viTranslation || msg.viError || translatingViId === msg.id) && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="mt-2.5 pt-2 border-t border-[var(--cydia-bot-border)] text-[14px] leading-[1.5] cursor-text"
                        >
                          {msg.viError ? (
                            <span className="text-red-600 text-[13px]">{msg.viError}</span>
                          ) : msg.viTranslation ? (
                            <span className="opacity-80">{msg.viTranslation}</span>
                          ) : (
                            <span className="opacity-50 text-[13px]">Đang dịch sang tiếng Việt...</span>
                          )}
                        </div>
                      )}
                    </div>

                    {!msg.isError && !isCurrentlyStreaming && msg.text.trim().length > 0 && (
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
                        className={`inline-flex items-center justify-center min-h-[38px] min-w-[38px] rounded-full border border-transparent transition-all duration-150 disabled:opacity-40 cursor-pointer shrink-0 pb-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
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

      {/* Minimal bottom composer */}
      <div className="bg-white border-t border-[#EFEFF1] px-4 sm:px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
        <form onSubmit={handleSubmit} className="flex items-end gap-2 bg-[#F4F4F5] rounded-[28px] pl-4 pr-1.5 py-1.5">
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
            className="flex-1 bg-transparent resize-none py-2.5 text-[16px] sm:text-[15px] leading-[1.45] text-[#111111] placeholder:text-[#8E8E93] focus:outline-none max-h-36"
          />

          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            aria-label="Gửi tin nhắn"
            className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] shrink-0 transition-all duration-150 hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
          >
            <ArrowUp className="w-5 h-5" strokeWidth={2.2} />
          </button>
        </form>
      </div>
    </div>
  );
}
