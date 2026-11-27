import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ArrowUp,
  Check,
  Plus,
  RotateCcw,
  ClipboardPaste,
  Trash2,
  Mic,
  Square,
  Loader2,
  X,
} from 'lucide-react';
import { ChatMessage } from '../types';
import { formatDateGroup, formatTime } from '../utils/formatters';

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingMessageId: string | null;
  copiedMessageId: string | null;
  onCopyMessage: (messageId: string, text: string) => void;
  onSend: (text: string) => void;
  onRegenerate: (messageId: string, sourceText: string) => void;
  onClearChat: () => void;
}

function pickAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('READ_ERROR'));
    reader.readAsDataURL(blob);
  });
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function ChatPanel({
  messages,
  isLoading,
  streamingMessageId,
  copiedMessageId,
  onCopyMessage,
  onSend,
  onRegenerate,
  onClearChat,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const quickMenuRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const cancelRecordingRef = useRef(false);
  const recordingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  useEffect(() => {
    if (!showQuickMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setShowQuickMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [showQuickMenu]);

  const stopMediaTracks = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelRecordingRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      stopMediaTracks();
    };
  }, [stopMediaTracks]);

  const transcribeAudioBlob = useCallback(async (blob: Blob, mimeType: string) => {
    if (blob.size < 500) {
      setNotice('Đoạn ghi âm quá ngắn, thử nói lại nhé.');
      return;
    }

    setIsTranscribing(true);
    setNotice(null);

    try {
      const audioBase64 = await blobToBase64(blob);
      const sendReq = () =>
        fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64,
            mimeType: mimeType || blob.type || 'audio/webm',
          }),
        });

      let res = await sendReq();
      if (res.ok && res.headers.get('x-cydia-translate') !== '1') {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        res = await sendReq();
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || !contentType.includes('application/json')) {
        let errMsg = 'Không nhận diện được giọng nói. Thử lại nhé.';
        if (contentType.includes('application/json')) {
          try {
            const errData = (await res.json()) as { error?: string };
            if (errData.error) errMsg = errData.error;
          } catch {
            // Keep default
          }
        }
        setNotice(errMsg);
        return;
      }

      const data = (await res.json()) as { text?: string };
      const transcript = (data.text ?? '').trim();
      if (!transcript) {
        setNotice('Không nghe rõ giọng nói, thử nói lại nhé.');
        return;
      }

      setInput((prev) => {
        const cleanPrev = prev.trim();
        return cleanPrev ? `${cleanPrev} ${transcript}` : transcript;
      });

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    } catch {
      setNotice('Không thể gửi đoạn ghi âm. Kiểm tra kết nối rồi thử lại nhé.');
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const startRecording = async () => {
    if (isRecording || isTranscribing) return;
    setNotice(null);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice('Trình duyệt hiện tại không hỗ trợ ghi âm micro.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      cancelRecordingRef.current = false;

      const chosenMime = pickAudioMimeType();
      const recorder = chosenMime
        ? new MediaRecorder(stream, { mimeType: chosenMime })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const chunks = audioChunksRef.current;
        const mime = recorder.mimeType || chosenMime || 'audio/webm';
        const cancelled = cancelRecordingRef.current;
        stopMediaTracks();
        setIsRecording(false);
        setRecordingSeconds(0);

        if (!cancelled && chunks.length > 0) {
          const blob = new Blob(chunks, { type: mime });
          void transcribeAudioBlob(blob, mime);
        }
      };

      recorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      stopMediaTracks();
      const errName = (err as { name?: string })?.name;
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setNotice('Chưa có quyền dùng micro — hãy cho phép micro trên trình duyệt.');
      } else {
        setNotice('Không thể mở micro. Kiểm tra thiết bị thu âm nhé.');
      }
    }
  };

  const stopRecording = (cancel = false) => {
    cancelRecordingRef.current = cancel;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      stopMediaTracks();
      setIsRecording(false);
      setRecordingSeconds(0);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading || isRecording || isTranscribing) return;
    setInput('');
    setNotice(null);
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

  const handlePasteFromClipboard = async () => {
    setShowQuickMenu(false);
    setNotice(null);
    try {
      const clipText = await navigator.clipboard.readText();
      if (clipText) {
        setInput((prev) => (prev ? `${prev} ${clipText}` : clipText));
        textareaRef.current?.focus();
      }
    } catch {
      setNotice('Trình duyệt chặn đọc clipboard tự động — hãy bấm Ctrl+V / Cmd+V.');
      textareaRef.current?.focus();
    }
  };

  const handleClearFromMenu = () => {
    setShowQuickMenu(false);
    onClearChat();
  };

  const showStandaloneDots =
    isLoading &&
    (!streamingMessageId ||
      messages.find((m) => m.id === streamingMessageId)?.text.trim() === '');

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--cydia-chat-bg)] transition-colors duration-150">
      {/* Scrollable message feed */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
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
                      {msg.text}
                    </div>

                    {/* Regenerate / retry button */}
                    {!msg.isError && !isCurrentlyStreaming && msg.sourceText && (
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={() => onRegenerate(msg.id, msg.sourceText!)}
                        aria-label="Dịch lại"
                        title="Dịch lại theo mode hiện tại"
                        className="inline-flex items-center justify-center min-h-[38px] min-w-[38px] rounded-full border border-transparent text-[var(--cydia-chat-muted)] hover:text-[var(--cydia-chat-strong)] hover:bg-black/5 transition-all duration-150 disabled:opacity-40 cursor-pointer shrink-0 pb-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
                      >
                        <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.9} />
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

        {/* Typing indicator before first token arrives */}
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

      {/* Bottom composer */}
      <div className="bg-white border-t border-[#EFEFF1] px-4 sm:px-6 py-3.5 shrink-0">
        {notice && (
          <p className="text-[12px] text-[#71717A] mb-2 px-2">{notice}</p>
        )}

        <form onSubmit={handleSubmit} className="relative flex items-end gap-1.5 bg-[#F4F4F5] rounded-[28px] px-2 py-1.5">
          {isRecording ? (
            <div className="flex items-center justify-between flex-1 min-h-[40px] pl-2 pr-1 gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                <span className="text-[14px] font-medium text-[#111111] whitespace-nowrap">
                  Đang nghe...
                </span>
                <span className="text-[13px] text-[#71717A] tabular-nums">
                  {formatDuration(recordingSeconds)}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => stopRecording(true)}
                  aria-label="Hủy ghi âm"
                  title="Hủy ghi âm"
                  className="flex items-center justify-center w-9 h-9 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-black/5 transition-colors cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
                <button
                  type="button"
                  onClick={() => stopRecording(false)}
                  aria-label="Dừng ghi âm và chuyển thành chữ"
                  title="Xong"
                  className="flex items-center justify-center w-10 h-10 rounded-full bg-red-600 text-white hover:bg-red-700 active:scale-95 transition-all cursor-pointer"
                >
                  <Square className="w-4 h-4 fill-current" />
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="relative shrink-0" ref={quickMenuRef}>
                <button
                  type="button"
                  onClick={() => setShowQuickMenu((v) => !v)}
                  aria-label="Thao tác nhanh"
                  className="flex items-center justify-center w-10 h-10 rounded-full text-[#52525B] hover:text-[#111111] hover:bg-black/5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#111111]"
                >
                  <Plus className="w-5 h-5" strokeWidth={1.8} />
                </button>

                {showQuickMenu && (
                  <div className="absolute bottom-13 left-0 w-52 bg-white border border-[#E5E5E7] rounded-2xl shadow-lg py-1.5 z-30">
                    <button
                      type="button"
                      onClick={handlePasteFromClipboard}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-medium text-[#111111] hover:bg-[#F4F4F5] transition-colors text-left cursor-pointer"
                    >
                      <ClipboardPaste className="w-4 h-4 text-[#52525B]" />
                      <span>Dán từ bộ nhớ tạm</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleClearFromMenu}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-medium text-[#111111] hover:bg-[#F4F4F5] transition-colors text-left cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4 text-[#52525B]" />
                      <span>Làm mới khung chat</span>
                    </button>
                  </div>
                )}
              </div>

              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                disabled={isTranscribing}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (notice) setNotice(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder={isTranscribing ? 'Đang chuyển giọng nói thành chữ...' : 'Nhập tin nhắn...'}
                className="flex-1 bg-transparent resize-none py-2.5 px-1 text-[15px] leading-[1.45] text-[#111111] placeholder:text-[#8E8E93] focus:outline-none max-h-36 disabled:opacity-60"
              />

              {/* Voice Input Button */}
              <button
                type="button"
                disabled={isTranscribing}
                onClick={startRecording}
                aria-label="Nhập bằng giọng nói"
                title="Nói tiếng Việt hoặc tiếng Anh để điền vào ô nhập"
                className="flex items-center justify-center w-10 h-10 rounded-full text-[#52525B] hover:text-[#111111] hover:bg-black/5 transition-colors shrink-0 disabled:opacity-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#111111]"
              >
                {isTranscribing ? (
                  <Loader2 className="w-4.5 h-4.5 animate-spin text-[#111111]" />
                ) : (
                  <Mic className="w-4.5 h-4.5" strokeWidth={1.9} />
                )}
              </button>

              <button
                type="submit"
                disabled={!input.trim() || isLoading || isTranscribing}
                aria-label="Gửi tin nhắn"
                className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] shrink-0 transition-all duration-150 hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
              >
                <ArrowUp className="w-5 h-5" strokeWidth={2.2} />
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
