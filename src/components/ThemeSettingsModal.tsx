import React, { useEffect, useState } from 'react';
import { Bookmark, Check, RotateCcw, Trash2, X } from 'lucide-react';
import { ChatTheme, ThemePreset, VoiceGender } from '../types';
import { DEFAULT_THEME } from '../defaults';

interface ThemeSettingsModalProps {
  isOpen: boolean;
  voiceGender: VoiceGender;
  theme: ChatTheme;
  savedThemes: ThemePreset[];
  onVoiceGenderChange: (gender: VoiceGender) => void;
  onThemeChange: (theme: ChatTheme) => void;
  onSaveCustomTheme: (name: string, theme: ChatTheme) => void;
  onDeleteCustomTheme: (presetId: string) => void;
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

export function ThemeSettingsModal({
  isOpen,
  voiceGender,
  theme,
  savedThemes,
  onVoiceGenderChange,
  onThemeChange,
  onSaveCustomTheme,
  onDeleteCustomTheme,
  onClearChat,
  onClose,
}: ThemeSettingsModalProps) {
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  if (!isOpen) return null;

  const isMale = voiceGender === 'male';

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
        className="w-full md:max-w-[820px] bg-white rounded-t-3xl md:rounded-3xl border border-[#EAEAEA] shadow-xl overflow-hidden flex flex-col max-h-[90dvh] md:max-h-[88dvh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 md:px-6 h-[56px] border-b border-[#EFEFF1] shrink-0">
          <h2 id="settings-modal-title" className="text-[17px] font-bold tracking-tight text-[#111111]">
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
        <div className="overflow-y-auto grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-[#F0F0F2]">
          <div className="px-5 md:px-6 py-5 space-y-6">
          {/* Voice Gender (Nữ / Nam) */}
          <section className="space-y-2.5">
            <span className="block text-[12px] font-semibold tracking-wider text-[#71717A] uppercase">
              Giọng đọc phát âm
            </span>
            <div className="flex items-center justify-between gap-3 px-4 py-3.5 rounded-2xl border border-[#EAEAEA] bg-white">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[#111111]">
                  {isMale ? 'Giọng nam' : 'Giọng nữ'}
                </div>
                <div className="text-[12px] text-[#71717A] mt-0.5">
                  {isMale
                    ? 'Giọng nam tiếng Anh Mỹ (Microsoft Neural)'
                    : 'Giọng nữ tiếng Anh Mỹ (Microsoft Neural)'}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onVoiceGenderChange('female')}
                  className={`text-[13px] py-1 transition-colors whitespace-nowrap cursor-pointer ${
                    !isMale
                      ? 'font-semibold text-[#111111]'
                      : 'font-medium text-[#8E8E93] hover:text-[#52525B]'
                  }`}
                >
                  Nữ
                </button>

                <button
                  type="button"
                  role="switch"
                  aria-checked={isMale}
                  aria-label="Chuyển giữa giọng đọc nữ và nam"
                  onClick={() => onVoiceGenderChange(isMale ? 'female' : 'male')}
                  className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-[var(--cydia-accent)] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
                >
                  <span
                    className={`inline-block h-4.5 w-4.5 transform rounded-full bg-[var(--cydia-switch-knob)] shadow-xs transition-transform duration-150 ${
                      isMale ? 'translate-x-5.5' : 'translate-x-1'
                    }`}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => onVoiceGenderChange('male')}
                  className={`text-[13px] py-1 transition-colors whitespace-nowrap cursor-pointer ${
                    isMale
                      ? 'font-semibold text-[#111111]'
                      : 'font-medium text-[#8E8E93] hover:text-[#52525B]'
                  }`}
                >
                  Nam
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
                    Xóa tin nhắn hiện tại (tự động xóa sau 00:00 mỗi ngày)
                  </div>
                </div>
              </div>
            </button>
          </section>
          </div>

          {/* Theme colors column */}
          <div className="px-5 md:px-6 pb-5 pt-0 md:py-5">
          <section className="space-y-3 pt-4 md:pt-0 border-t md:border-t-0 border-[#F0F0F2]">
            <div className="flex items-center justify-between gap-2">
              <span className="block text-[12px] font-semibold tracking-wider text-[#71717A] uppercase">
                Màu sắc giao diện
              </span>
              <button
                type="button"
                onClick={() => {
                  onSaveCustomTheme(`Bộ màu ${savedThemes.length + 1}`, theme);
                  setJustSaved(true);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[#E5E5EA] bg-white hover:bg-[#F4F4F5] text-[12px] font-medium text-[#111111] transition-colors cursor-pointer"
              >
                {justSaved ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" strokeWidth={2.3} />
                    <span>Đã lưu</span>
                  </>
                ) : (
                  <>
                    <Bookmark className="w-3.5 h-3.5" strokeWidth={1.9} />
                    <span>Lưu bộ màu</span>
                  </>
                )}
              </button>
            </div>

            {/* Saved custom presets */}
            {savedThemes.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <span className="block text-[11px] font-medium text-[#8E8E93]">
                  Bộ màu đã lưu
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {savedThemes.map((preset) => {
                    const active = isPresetActive(preset.theme);
                    return (
                      <div
                        key={preset.id}
                        className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-xl border text-[12px] transition-all ${
                          active
                            ? 'border-[#111111] bg-[#F4F4F5] font-semibold text-[#111111]'
                            : 'border-[#EAEAEA] bg-white hover:border-[#C8C8CE] text-[#52525B]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onThemeChange(preset.theme)}
                          className="inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <span className="truncate max-w-[100px]">{preset.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteCustomTheme(preset.id)}
                          aria-label={`Xóa ${preset.name}`}
                          className="p-0.5 rounded-full text-[#8E8E93] hover:text-[#111111] hover:bg-black/5 transition-colors cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
                      onInput={(e) => updateField(field.key, e.currentTarget.value)}
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
            onClick={() => {
              onThemeChange(theme);
              onClose();
            }}
            className="px-5 py-2 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] text-[13px] font-semibold hover:opacity-90 transition-opacity cursor-pointer"
          >
            Xong
          </button>
        </div>
      </div>
    </div>
  );
}
