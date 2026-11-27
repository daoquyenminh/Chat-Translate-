import React, { useEffect } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { ChatTheme, TranslationMode } from '../types';
import { DEFAULT_THEME, THEME_PRESETS } from '../defaults';

interface ThemeSettingsModalProps {
  isOpen: boolean;
  mode: TranslationMode;
  theme: ChatTheme;
  onModeChange: (mode: TranslationMode) => void;
  onThemeChange: (theme: ChatTheme) => void;
  onClearChat: () => void;
  onClose: () => void;
}

const COLOR_FIELDS: { key: keyof ChatTheme; label: string; hint: string }[] = [
  {
    key: 'accentColor',
    label: 'Màu nút & điểm nhấn',
    hint: 'Nút gửi, nút gạt',
  },
  {
    key: 'userBubbleColor',
    label: 'Tin nhắn của bạn',
    hint: 'Màu nền bóng chat gửi đi',
  },
  {
    key: 'botBubbleColor',
    label: 'Tin nhắn dịch',
    hint: 'Màu nền bóng chat kết quả',
  },
  {
    key: 'chatBgColor',
    label: 'Nền khung chat',
    hint: 'Màu nền khu vực trò chuyện',
  },
];

const SWATCH_CLASS: Record<string, string> = {
  minimal: 'bg-[#111111]',
  ocean: 'bg-[#2563EB]',
  emerald: 'bg-[#059669]',
  plum: 'bg-[#6D28D9]',
  terracotta: 'bg-[#EA580C]',
  dark: 'bg-[#27272A]',
};

export function ThemeSettingsModal({
  isOpen,
  mode,
  theme,
  onModeChange,
  onThemeChange,
  onClearChat,
  onClose,
}: ThemeSettingsModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isFormal = mode === 'formal';

  const isPresetActive = (presetTheme: ChatTheme) =>
    presetTheme.accentColor.toLowerCase() === theme.accentColor.toLowerCase() &&
    presetTheme.userBubbleColor.toLowerCase() === theme.userBubbleColor.toLowerCase() &&
    presetTheme.botBubbleColor.toLowerCase() === theme.botBubbleColor.toLowerCase() &&
    presetTheme.chatBgColor.toLowerCase() === theme.chatBgColor.toLowerCase();

  const updateField = (key: keyof ChatTheme, value: string) => {
    onThemeChange({
      ...theme,
      [key]: value,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-[2px] p-0 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        className="w-full sm:max-w-[420px] bg-white rounded-t-3xl sm:rounded-3xl border border-[#EAEAEA] shadow-xl overflow-hidden flex flex-col max-h-[90dvh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-[58px] border-b border-[#EFEFF1] shrink-0">
          <h2 id="settings-modal-title" className="text-[16px] font-semibold text-[#111111]">
            Cài đặt
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            className="flex items-center justify-center w-9 h-9 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-5 space-y-6">
          {/* Translation Mode (Chat / Formal) */}
          <section className="space-y-2.5">
            <span className="block text-[12px] font-semibold tracking-wider text-[#71717A] uppercase">
              Chế độ dịch
            </span>
            <div className="flex items-center justify-between gap-3 px-4 py-3.5 rounded-2xl border border-[#EAEAEA] bg-white">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[#111111]">
                  {isFormal ? 'Formal' : 'Chat'}
                </div>
                <div className="text-[12px] text-[#71717A] mt-0.5">
                  {isFormal
                    ? 'Chỉnh chu, lịch sự, đầy đủ ngữ pháp'
                    : 'Ngắn gọn, đủ chủ ngữ, viết tắt tự nhiên'}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onModeChange('chat')}
                  className={`text-[13px] py-1 transition-colors whitespace-nowrap cursor-pointer ${
                    !isFormal
                      ? 'font-semibold text-[#111111]'
                      : 'font-medium text-[#8E8E93] hover:text-[#52525B]'
                  }`}
                >
                  Chat
                </button>

                <button
                  type="button"
                  role="switch"
                  aria-checked={isFormal}
                  aria-label="Chuyển giữa chế độ Chat và Formal"
                  onClick={() => onModeChange(isFormal ? 'chat' : 'formal')}
                  className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-[var(--cydia-accent)] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
                >
                  <span
                    className={`inline-block h-4.5 w-4.5 transform rounded-full bg-[var(--cydia-switch-knob)] shadow-xs transition-transform duration-150 ${
                      isFormal ? 'translate-x-5.5' : 'translate-x-1'
                    }`}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => onModeChange('formal')}
                  className={`text-[13px] py-1 transition-colors whitespace-nowrap cursor-pointer ${
                    isFormal
                      ? 'font-semibold text-[#111111]'
                      : 'font-medium text-[#8E8E93] hover:text-[#52525B]'
                  }`}
                >
                  Formal
                </button>
              </div>
            </div>
          </section>

          {/* Clear Chat Action */}
          <section className="space-y-2.5">
            <span className="block text-[12px] font-semibold tracking-wider text-[#71717A] uppercase">
              Đoạn chat
            </span>
            <button
              type="button"
              onClick={() => {
                onClearChat();
                onClose();
              }}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-[#EAEAEA] bg-white hover:bg-[#FAFAFA] hover:border-[#D4D4D8] transition-colors cursor-pointer text-left"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-[#F4F4F5] text-[#52525B] shrink-0">
                  <Trash2 className="w-4 h-4" />
                </span>
                <div>
                  <div className="text-[14px] font-medium text-[#111111]">
                    Làm mới khung chat
                  </div>
                  <div className="text-[12px] text-[#8E8E93]">
                    Xóa các tin nhắn hiện tại trên màn hình
                  </div>
                </div>
              </div>
            </button>
          </section>

          {/* Live mini preview */}
          <section className="space-y-2.5">
            <span className="block text-[12px] font-semibold tracking-wider text-[#71717A] uppercase">
              Màu sắc giao diện
            </span>

            <div className="rounded-2xl border border-[#EAEAEA] p-4 space-y-2.5 bg-[var(--cydia-chat-bg)]">
              <div className="flex justify-end">
                <div className="px-3.5 py-2 rounded-[16px] rounded-br-[5px] text-[13px] bg-[var(--cydia-user-bg)] text-[var(--cydia-user-text)]">
                  tôi cần chuyển cái này sang factory 2
                </div>
              </div>
              <div className="flex justify-start">
                <div className="px-3.5 py-2 rounded-[16px] rounded-bl-[5px] text-[13px] border bg-[var(--cydia-bot-bg)] text-[var(--cydia-bot-text)] border-[var(--cydia-bot-border)]">
                  I gotta move this to factory 2
                </div>
              </div>
            </div>

            {/* Presets */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              {THEME_PRESETS.map((preset) => {
                const active = isPresetActive(preset.theme);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onThemeChange(preset.theme)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                      active
                        ? 'border-[#111111] bg-[#F4F4F5] font-semibold text-[#111111]'
                        : 'border-[#EAEAEA] bg-white hover:border-[#C8C8CE] text-[#52525B]'
                    }`}
                  >
                    <span
                      className={`w-4 h-4 rounded-full shrink-0 border border-black/10 ${
                        SWATCH_CLASS[preset.id] ?? 'bg-[#111111]'
                      }`}
                    />
                    <span className="text-[13px] truncate">{preset.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Custom color pickers */}
            <div className="divide-y divide-[#F0F0F2] border border-[#EAEAEA] rounded-2xl bg-white overflow-hidden">
              {COLOR_FIELDS.map((field) => (
                <label
                  key={field.key}
                  className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-[#FAFAFA] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-[#111111]">
                      {field.label}
                    </div>
                    <div className="text-[12px] text-[#8E8E93]">{field.hint}</div>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <span className="text-[12px] font-mono uppercase text-[#71717A] tabular-nums">
                      {theme[field.key]}
                    </span>
                    <input
                      type="color"
                      value={theme[field.key]}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      aria-label={field.label}
                      className="w-8 h-8 rounded-full border border-[#E5E5E7] bg-transparent cursor-pointer overflow-hidden p-0"
                    />
                  </div>
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-[#EFEFF1] bg-white shrink-0">
          <button
            type="button"
            onClick={() => onThemeChange(DEFAULT_THEME)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-medium text-[#52525B] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Màu mặc định</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] text-[13px] font-semibold hover:opacity-90 transition-opacity cursor-pointer"
          >
            Xong
          </button>
        </div>
      </div>
    </div>
  );
}
