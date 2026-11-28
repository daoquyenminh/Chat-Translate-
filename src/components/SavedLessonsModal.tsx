import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Search, Trash2, X } from 'lucide-react';
import { SavedLesson } from '../types';

interface SavedLessonsModalProps {
  isOpen: boolean;
  lessons: SavedLesson[];
  onSelectLesson: (lesson: SavedLesson) => void;
  onDeleteLesson: (lessonId: string) => void;
  onClose: () => void;
}

function formatSavedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm} · ${dd}/${mo}`;
}

export function SavedLessonsModal({
  isOpen,
  lessons,
  onSelectLesson,
  onDeleteLesson,
  onClose,
}: SavedLessonsModalProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const filteredLessons = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lessons;
    return lessons.filter(
      (l) =>
        l.sourceText.toLowerCase().includes(q) ||
        l.translatedText.toLowerCase().includes(q) ||
        l.data.correctedSentence.toLowerCase().includes(q)
    );
  }, [lessons, query]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-[2px] p-0 md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-lessons-title"
        className="w-full md:max-w-[92vw] xl:max-w-[1220px] bg-white rounded-t-3xl md:rounded-3xl border border-[#EAEAEA] shadow-xl overflow-hidden flex flex-col max-h-[86dvh] md:max-h-[86dvh]"
      >
        {/* Mobile grab handle */}
        <div className="md:hidden flex justify-center pt-2.5 pb-1 shrink-0">
          <span className="w-10 h-1 rounded-full bg-[#E4E4E7]" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 md:px-6 h-[56px] border-b border-[#EFEFF1] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2
              id="saved-lessons-title"
              className="text-[17px] font-bold tracking-tight text-[#111111] whitespace-nowrap"
            >
              Bài học đã lưu
            </h2>
            <span aria-hidden="true" className="text-[#D4D4D8]">
              ·
            </span>
            <span className="text-[13px] text-[#71717A] tabular-nums whitespace-nowrap">
              {lessons.length} bài
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng danh sách bài học"
            className="flex items-center justify-center w-10 h-10 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4.5 h-4.5" strokeWidth={2} />
          </button>
        </div>

        {/* Optional search bar when user has multiple saved lessons */}
        {lessons.length > 3 && (
          <div className="px-5 md:px-6 pt-3.5 pb-1 shrink-0">
            <div className="flex items-center gap-2 px-3.5 h-10 rounded-full bg-[#F4F4F5]">
              <Search className="w-4 h-4 text-[#8E8E93] shrink-0" strokeWidth={2} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm bài học đã lưu..."
                className="flex-1 min-w-0 bg-transparent text-[14px] text-[#111111] placeholder:text-[#8E8E93] focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Xóa từ khóa tìm kiếm"
                  className="p-1 rounded-full text-[#71717A] hover:text-[#111111] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 md:px-6 py-4">
          {lessons.length === 0 ? (
            <div className="py-12 px-4 text-center space-y-2.5">
              <div className="w-11 h-11 rounded-full bg-[#F4F4F5] text-[#71717A] flex items-center justify-center mx-auto">
                <BookOpen className="w-5 h-5" strokeWidth={1.8} />
              </div>
              <p className="text-[14px] font-medium text-[#111111]">
                Chưa có bài học nào được lưu
              </p>
              <p className="text-[13px] text-[#71717A] max-w-[340px] mx-auto leading-relaxed">
                Bấm biểu tượng quyển sách cạnh mỗi tin nhắn rồi chọn Lưu bài học để lưu giữ mãi và ôn lại bất cứ lúc nào.
              </p>
            </div>
          ) : filteredLessons.length === 0 ? (
            <div className="py-10 text-center text-[14px] text-[#71717A]">
              Không tìm thấy bài học khớp với &ldquo;{query.trim()}&rdquo;.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredLessons.map((lesson) => (
                <div
                  key={lesson.id}
                  className="group flex items-start justify-between gap-2 p-4 rounded-2xl border border-[#EAEAEA] bg-white hover:border-[#D4D4D8] hover:bg-[#FAFAFA] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => onSelectLesson(lesson)}
                    className="flex-1 min-w-0 text-left space-y-1.5 cursor-pointer"
                  >
                    <div className="text-[14px] font-semibold text-[#111111] leading-[1.45] line-clamp-2 break-words">
                      {lesson.data.correctedSentence || lesson.translatedText}
                    </div>
                    <div className="text-[13px] text-[#71717A] line-clamp-1 break-words">
                      {lesson.sourceText}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[#A1A1AA] tabular-nums pt-0.5">
                      <span>{formatSavedDate(lesson.savedAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{lesson.mode === 'formal' ? 'Formal' : 'Chat'}</span>
                      {lesson.data.mistakes.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{lesson.data.mistakes.length} lỗi đã sửa</span>
                        </>
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => onDeleteLesson(lesson.id)}
                    aria-label="Xóa bài học đã lưu"
                    title="Xóa bài học"
                    className="flex items-center justify-center w-9 h-9 rounded-full text-[#A1A1AA] hover:text-red-600 hover:bg-red-50 transition-colors shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={1.9} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 md:px-6 py-3.5 border-t border-[#EFEFF1] bg-white pb-[max(0.875rem,env(safe-area-inset-bottom))] shrink-0">
          <span className="text-[12px] text-[#8E8E93]">
            Bài học đã lưu được giữ lại vĩnh viễn, không tự động xóa theo ngày.
          </span>
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
