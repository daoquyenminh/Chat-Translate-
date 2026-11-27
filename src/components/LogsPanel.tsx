import React, { useState, useMemo } from 'react';
import { Check, Copy, Download, Search, Trash2, X } from 'lucide-react';
import { TranslationLog } from '../types';
import { copyTextToClipboard, downloadLogsFile, formatFullDateTime } from '../utils/formatters';

interface LogsPanelProps {
  logs: TranslationLog[];
  onDeleteLog: (id: string) => void;
  onClearLogs: () => void;
}

export function LogsPanel({ logs, onDeleteLog, onClearLogs }: LogsPanelProps) {
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(
      (item) =>
        item.input.toLowerCase().includes(q) || item.output.toLowerCase().includes(q)
    );
  }, [logs, query]);

  const handleCopy = async (id: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[#FAFAFA]">
      {/* Search & export toolbar */}
      <div className="px-4 sm:px-5 pt-4 pb-3 space-y-3 border-b border-[#EFEFF1] bg-white shrink-0">
        <div className="relative">
          <Search className="w-4 h-4 text-[#A1A1AA] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm trong log đã lưu..."
            className="w-full bg-[#F4F4F5] rounded-full pl-9 pr-9 py-2 text-[14px] text-[#111111] placeholder:text-[#8E8E93] focus:outline-none focus:ring-2 focus:ring-[#111111]/10"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Xóa từ khóa tìm kiếm"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full text-[#71717A] hover:text-[#111111] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-[#71717A] tabular-nums">
            {logs.length} bản ghi
          </span>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={logs.length === 0}
              onClick={() => downloadLogsFile(logs, 'txt')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-[#E5E5E7] bg-white text-[#111111] font-medium hover:bg-[#F4F4F5] disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>.txt</span>
            </button>
            <button
              type="button"
              disabled={logs.length === 0}
              onClick={() => downloadLogsFile(logs, 'json')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-[#E5E5E7] bg-white text-[#111111] font-medium hover:bg-[#F4F4F5] disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>.json</span>
            </button>

            {logs.length > 0 && (
              confirmClear ? (
                <button
                  type="button"
                  onClick={() => {
                    onClearLogs();
                    setConfirmClear(false);
                  }}
                  onMouseLeave={() => setConfirmClear(false)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-red-600 text-white font-medium hover:bg-red-700 transition-colors cursor-pointer whitespace-nowrap"
                >
                  Xác nhận xóa
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  aria-label="Xóa toàn bộ log"
                  className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[#71717A] hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-2.5">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-12 px-4">
            <p className="text-[14px] font-medium text-[#52525B]">
              {logs.length === 0 ? 'Chưa có log nào được lưu' : 'Không tìm thấy kết quả phù hợp'}
            </p>
            <p className="text-[13px] text-[#8E8E93] mt-1">
              {logs.length === 0
                ? 'Mọi câu bạn dịch sẽ tự động lưu tại đây trên thiết bị này.'
                : 'Thử từ khóa khác nhé.'}
            </p>
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const isCopied = copiedId === entry.id;
            return (
              <div
                key={entry.id}
                className="bg-white border border-[#EAEAEA] rounded-2xl p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[#8E8E93] tabular-nums">
                    {formatFullDateTime(entry.createdAt)} · {entry.mode === 'formal' ? 'Formal' : 'Chat'}
                  </span>
                  <button
                    type="button"
                    onClick={() => onDeleteLog(entry.id)}
                    aria-label="Xóa bản ghi này"
                    className="w-7 h-7 flex items-center justify-center rounded-full text-[#A1A1AA] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <p className="text-[13px] text-[#71717A] leading-[1.45] whitespace-pre-wrap break-words">
                  {entry.input}
                </p>

                <div className="flex items-start justify-between gap-2.5 pt-1 border-t border-[#F4F4F5]">
                  <p className="text-[14px] font-medium text-[#111111] leading-[1.5] whitespace-pre-wrap break-words flex-1">
                    {entry.output}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleCopy(entry.id, entry.output)}
                    aria-label="Sao chép bản dịch"
                    className={`inline-flex items-center gap-1 min-h-[34px] px-2.5 rounded-full border text-[12px] font-medium shrink-0 transition-colors cursor-pointer ${
                      isCopied
                        ? 'bg-[#111111] text-white border-[#111111]'
                        : 'bg-white text-[#52525B] border-[#E5E5E7] hover:text-[#111111]'
                    }`}
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Đã copy</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
