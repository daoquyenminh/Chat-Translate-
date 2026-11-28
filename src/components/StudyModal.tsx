import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  Loader2,
  RotateCcw,
  Volume2,
  X,
} from 'lucide-react';
import { StudyAnalysis, StudyHighlightSegment, TranslationMode } from '../types';
import { copyTextToClipboard } from '../utils/formatters';

interface StudyModalProps {
  isOpen: boolean;
  sourceText: string;
  translatedText: string;
  mode: TranslationMode;
  data: StudyAnalysis | null;
  isLoading: boolean;
  error: string | null;
  isSaved: boolean;
  speakingKey: string | null;
  loadingSpeechKey: string | null;
  onSpeak: (key: string, text: string, mode?: TranslationMode) => void;
  onToggleSave: () => void;
  onRetry: () => void;
  onClose: () => void;
}

function getLoadingStageLabel(percent: number): string {
  if (percent < 32) return 'Đang đọc và tách câu gốc...';
  if (percent < 66) return 'Đang kiểm tra ngữ pháp & chính tả...';
  if (percent < 95) return 'Đang gợi ý ngữ cảnh & câu thay thế...';
  return 'Hoàn tất phân tích';
}

function renderSegments(segments: StudyHighlightSegment[]) {
  return segments.map((seg, idx) => {
    if (seg.status === 'wrong') {
      return (
        <mark
          key={idx}
          className="bg-red-50 text-red-700 line-through decoration-red-400 px-1 py-0.5 rounded-md font-medium"
        >
          {seg.text}
        </mark>
      );
    }
    if (seg.status === 'correct') {
      return (
        <mark
          key={idx}
          className="bg-emerald-50 text-emerald-800 px-1 py-0.5 rounded-md font-medium"
        >
          {seg.text}
        </mark>
      );
    }
    if (seg.status === 'key') {
      return (
        <mark
          key={idx}
          className="bg-amber-50 text-amber-900 px-1 py-0.5 rounded-md font-medium"
        >
          {seg.text}
        </mark>
      );
    }
    return <React.Fragment key={idx}>{seg.text}</React.Fragment>;
  });
}

export function StudyModal({
  isOpen,
  sourceText,
  translatedText,
  mode,
  data,
  isLoading,
  error,
  isSaved,
  speakingKey,
  loadingSpeechKey,
  onSpeak,
  onToggleSave,
  onRetry,
  onClose,
}: StudyModalProps) {
  const [progress, setProgress] = useState(0);
  const [showingCompletion, setShowingCompletion] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setProgress(0);
      setShowingCompletion(false);
      return;
    }

    if (isLoading) {
      setShowingCompletion(false);
      setProgress(12);
      const timer = window.setInterval(() => {
        setProgress((prev) => {
          if (prev >= 92) return prev;
          const step = prev < 45 ? 9 : prev < 75 ? 5 : 2;
          return Math.min(92, prev + step);
        });
      }, 180);
      return () => window.clearInterval(timer);
    }

    if (data && progress > 0 && progress < 100) {
      setProgress(100);
      setShowingCompletion(true);
      const doneTimer = window.setTimeout(() => {
        setShowingCompletion(false);
      }, 220);
      return () => window.clearTimeout(doneTimer);
    }

    if (data) {
      setProgress(100);
      setShowingCompletion(false);
    }
  }, [isOpen, isLoading, data]);

  useEffect(() => {
    if (!copiedKey) return;
    const timer = window.setTimeout(() => setCopiedKey(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  if (!isOpen) return null;

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedKey(key);
    }
  };

  const showLoader = isLoading || showingCompletion;
  const canSave = !showLoader && !error && Boolean(data);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-[2px] p-0 md:p-5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="study-modal-title"
        className="w-full md:max-w-[95vw] xl:max-w-[1420px] bg-white rounded-t-3xl md:rounded-3xl border border-[#EAEAEA] shadow-xl overflow-hidden flex flex-col max-h-[88dvh] md:max-h-[90dvh]"
      >
        {/* Mobile grab handle */}
        <div className="md:hidden flex justify-center pt-2.5 pb-1 shrink-0">
          <span className="w-10 h-1 rounded-full bg-[#E4E4E7]" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 md:px-6 h-[54px] border-b border-[#EFEFF1] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2
              id="study-modal-title"
              className="text-[17px] font-bold tracking-tight text-[#111111] whitespace-nowrap"
            >
              Học bài
            </h2>
            <span aria-hidden="true" className="text-[#D4D4D8]">
              ·
            </span>
            <span className="text-[13px] text-[#71717A] whitespace-nowrap">
              {mode === 'formal' ? 'Formal' : 'Chat'}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {!showLoader && (
              <button
                type="button"
                onClick={onRetry}
                aria-label="Phân tích lại"
                title="Phân tích lại"
                className="flex items-center justify-center w-10 h-10 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" strokeWidth={2} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng cửa sổ học bài"
              className="flex items-center justify-center w-10 h-10 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer"
            >
              <X className="w-4.5 h-4.5" strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Body: vertical stack on mobile, wide 3-column horizontal layout on PC */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {showLoader ? (
            <div className="py-12 px-5 md:px-10 max-w-[540px] mx-auto space-y-5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[14px] font-medium text-[#111111]">
                  {getLoadingStageLabel(progress)}
                </span>
                <span className="text-[15px] font-semibold text-[#111111] tabular-nums">
                  {progress}%
                </span>
              </div>

              <svg
                viewBox="0 0 100 4"
                preserveAspectRatio="none"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Tiến độ phân tích học bài"
                className="w-full h-2 rounded-full bg-[#EFEFF1] overflow-hidden block"
              >
                <rect
                  x="0"
                  y="0"
                  height="4"
                  width={progress}
                  rx="2"
                  className="fill-[var(--cydia-accent)] transition-[width] duration-200 ease-out"
                />
              </svg>

              <div className="pt-2 space-y-1.5 text-[13px] text-[#71717A]">
                <div className="truncate">
                  <span className="text-[#A1A1AA]">Câu gốc:</span> {sourceText}
                </div>
                <div className="truncate">
                  <span className="text-[#A1A1AA]">Bản dịch:</span> {translatedText}
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="py-12 px-5 text-center space-y-4">
              <p className="text-[14px] text-red-600 leading-relaxed">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] text-[13px] font-semibold hover:opacity-90 transition-opacity cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Thử phân tích lại</span>
              </button>
            </div>
          ) : data ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 md:divide-x md:divide-[#F0F0F2]">
              {/* Column 1: Original vs Corrected + Usage Context */}
              <div className="px-5 md:px-5 py-4 md:py-5 space-y-5">
                <section className="space-y-2.5">
                  <h3 className="flex items-baseline gap-2 text-[15px] font-bold tracking-tight text-[#111111]">
                    <span className="text-[12px] font-semibold tabular-nums text-[var(--cydia-accent)]">
                      01.
                    </span>
                    <span>Phân tích &amp; sửa lỗi</span>
                  </h3>

                  <div className="rounded-2xl border border-[#EAEAEA] divide-y divide-[#F0F0F2] bg-[#FAFAFA]/60">
                    <div className="px-4 py-3 space-y-1">
                      <div className="text-[12px] font-medium text-[#71717A]">Câu bạn viết</div>
                      <p className="text-[14.5px] leading-[1.55] text-[#111111] whitespace-pre-wrap break-words">
                        {renderSegments(data.originalSegments)}
                      </p>
                    </div>

                    <div className="px-4 py-3 bg-white rounded-b-2xl space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-medium text-[#71717A]">
                          Câu tiếng Anh chuẩn
                        </span>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => onSpeak('study-main', data.correctedSentence, mode)}
                            className={`inline-flex items-center gap-1 text-[12px] font-medium transition-colors cursor-pointer py-0.5 ${
                              speakingKey === 'study-main'
                                ? 'text-[var(--cydia-accent)]'
                                : 'text-[#52525B] hover:text-[#111111]'
                            }`}
                          >
                            {loadingSpeechKey === 'study-main' ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                            ) : (
                              <Volume2 className="w-3.5 h-3.5" strokeWidth={2} />
                            )}
                            <span>
                              {speakingKey === 'study-main' ? 'Đang đọc' : 'Nghe'}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleCopy('corrected', data.correctedSentence)}
                            className="inline-flex items-center gap-1 text-[12px] font-medium text-[#52525B] hover:text-[#111111] transition-colors cursor-pointer py-0.5"
                          >
                            {copiedKey === 'corrected' ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-600" strokeWidth={2.3} />
                                <span className="text-emerald-700">Đã copy</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" strokeWidth={1.9} />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <p className="text-[14.5px] leading-[1.55] text-[#111111] whitespace-pre-wrap break-words">
                        {renderSegments(data.correctedSegments)}
                      </p>
                    </div>
                  </div>

                  {data.mistakes.length === 0 && (
                    <p className="text-[13px] text-[#71717A] leading-relaxed">
                      {data.inputType === 'vietnamese'
                        ? 'Câu gốc là tiếng Việt — phần tô sáng ở câu chuẩn là cấu trúc quan trọng nên nhớ.'
                        : 'Câu tiếng Anh của bạn đã chuẩn ngữ pháp và tự nhiên, không có lỗi sai.'}
                    </p>
                  )}
                </section>

                <section className="space-y-2 pt-4 border-t border-[#F0F0F2]">
                  <h3 className="flex items-baseline gap-2 text-[15px] font-bold tracking-tight text-[#111111]">
                    <span className="text-[12px] font-semibold tabular-nums text-[var(--cydia-accent)]">
                      02.
                    </span>
                    <span>Khi nào nên dùng</span>
                  </h3>
                  <p className="text-[13.5px] leading-[1.6] text-[#27272A]">
                    {data.usageContext}
                  </p>
                </section>
              </div>

              {/* Column 2: Detailed Mistake Fixes + Key Takeaways */}
              <div className="px-5 md:px-5 pb-4 pt-0 md:py-5 space-y-5">
                {data.mistakes.length > 0 && (
                  <section className="space-y-2.5 pt-4 md:pt-0 border-t md:border-t-0 border-[#F0F0F2]">
                    <h3 className="flex items-baseline gap-2 text-[15px] font-bold tracking-tight text-[#111111]">
                      <span className="text-[12px] font-semibold tabular-nums text-[var(--cydia-accent)]">
                        03.
                      </span>
                      <span>Chi tiết lỗi đã sửa</span>
                    </h3>

                    <ul className="divide-y divide-[#F0F0F2] border border-[#EAEAEA] rounded-2xl bg-white">
                      {data.mistakes.map((item, idx) => (
                        <li key={idx} className="px-3.5 py-2.5 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[13.5px]">
                            <span className="bg-red-50 text-red-700 line-through decoration-red-400 px-1.5 py-0.5 rounded-md font-medium">
                              {item.wrong}
                            </span>
                            <ArrowRight className="w-3.5 h-3.5 text-[#A1A1AA] shrink-0" />
                            <span className="bg-emerald-50 text-emerald-800 px-1.5 py-0.5 rounded-md font-semibold">
                              {item.correct}
                            </span>
                          </div>
                          <p className="text-[13px] leading-[1.5] text-[#52525B]">
                            {item.explanation}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {data.keyTakeaways.length > 0 && (
                  <section
                    className={`space-y-2.5 ${
                      data.mistakes.length > 0
                        ? 'pt-4 border-t border-[#F0F0F2]'
                        : 'pt-4 md:pt-0 border-t md:border-t-0 border-[#F0F0F2]'
                    }`}
                  >
                    <h3 className="flex items-baseline gap-2 text-[15px] font-bold tracking-tight text-[#111111]">
                      <span className="text-[12px] font-semibold tabular-nums text-[var(--cydia-accent)]">
                        {data.mistakes.length > 0 ? '04.' : '03.'}
                      </span>
                      <span>Cụm từ &amp; điểm cần nhớ</span>
                    </h3>
                    <div className="divide-y divide-[#F0F0F2] border border-[#EAEAEA] rounded-2xl bg-white overflow-hidden">
                      {data.keyTakeaways.map((tip, idx) => (
                        <div key={idx} className="px-3.5 py-2.5 space-y-0.5">
                          <div className="flex flex-wrap items-baseline gap-1.5 text-[13.5px]">
                            <span className="font-semibold text-[#111111]">{tip.phrase}</span>
                            <span aria-hidden="true" className="text-[#D4D4D8]">
                              ·
                            </span>
                            <span className="text-[#52525B]">{tip.meaning}</span>
                          </div>
                          {tip.note && (
                            <p className="text-[12.5px] text-[#71717A] leading-[1.45]">
                              {tip.note}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              {/* Column 3: Alternative Expressions */}
              <div className="px-5 md:px-5 pb-5 pt-0 xl:py-5 md:col-span-2 xl:col-span-1 md:border-t xl:border-t-0 border-[#F0F0F2]">
                {data.alternatives.length > 0 && (
                  <section className="space-y-2.5 pt-4 xl:pt-0 border-t md:border-t-0 border-[#F0F0F2]">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="flex items-baseline gap-2 text-[15px] font-bold tracking-tight text-[#111111]">
                        <span className="text-[12px] font-semibold tabular-nums text-[var(--cydia-accent)]">
                          {data.mistakes.length > 0 ? '05.' : '04.'}
                        </span>
                        <span>Cách nói thay thế khác</span>
                      </h3>
                      <span className="text-[12px] text-[#8E8E93] whitespace-nowrap shrink-0">
                        Bấm để copy
                      </span>
                    </div>

                    <div className="divide-y divide-[#F0F0F2] border border-[#EAEAEA] rounded-2xl bg-white overflow-hidden">
                      {data.alternatives.map((alt, idx) => {
                        const key = `alt-${idx}`;
                        const isCopied = copiedKey === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => void handleCopy(key, alt.english)}
                            className="w-full px-3.5 py-2.5 text-left hover:bg-[#FAFAFA] active:bg-[#F4F4F5] transition-colors cursor-pointer space-y-1"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-[13.5px] font-medium text-[#111111] leading-[1.45]">
                                {alt.english}
                              </span>
                              <span className="shrink-0 text-[12px] text-[#8E8E93] pt-0.5 whitespace-nowrap">
                                {isCopied ? (
                                  <span className="inline-flex items-center gap-0.5 text-emerald-700 font-medium">
                                    <Check className="w-3.5 h-3.5" strokeWidth={2.3} />
                                    Đã copy
                                  </span>
                                ) : (
                                  alt.tone
                                )}
                              </span>
                            </div>
                            <div className="text-[12.5px] italic text-[#71717A] leading-[1.45]">
                              {alt.vietnamese}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer with Save Lesson button + Close */}
        <div className="flex items-center justify-between gap-3 px-5 md:px-6 py-3.5 border-t border-[#EFEFF1] bg-white pb-[max(0.875rem,env(safe-area-inset-bottom))] shrink-0">
          <button
            type="button"
            disabled={!canSave}
            onClick={onToggleSave}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-full border text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              isSaved
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100/70'
                : 'border-[#E5E5EA] bg-white text-[#111111] hover:bg-[#F4F4F5]'
            }`}
          >
            {isSaved ? (
              <>
                <BookmarkCheck className="w-4 h-4 text-emerald-700" strokeWidth={2.1} />
                <span>Đã lưu bài học</span>
              </>
            ) : (
              <>
                <Bookmark className="w-4 h-4" strokeWidth={1.9} />
                <span>Lưu bài học</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] text-[13px] font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
