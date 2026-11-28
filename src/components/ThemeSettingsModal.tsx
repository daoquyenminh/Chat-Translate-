import React, { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Bookmark,
  Check,
  ChevronDown,
  Loader2,
  MessageSquareMore,
  Palette,
  Pipette,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  ChatFontSize,
  ChatTheme,
  EdgeVoiceId,
  ThemePreset,
  TranslationMode,
} from '../types';
import { EDGE_VOICE_OPTIONS } from '../../shared/edgeTts';
import { DEFAULT_THEME } from '../defaults';

export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 22;
export const DEFAULT_FONT_SIZE_PX = 15;

export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 1.5;

export const MIN_VOICE_SILENCE_SEC = 1;
export const MAX_VOICE_SILENCE_SEC = 10;
export const DEFAULT_VOICE_SILENCE_SEC = 3;

const FEMALE_VOICES = EDGE_VOICE_OPTIONS.filter((v) => v.gender === 'female');
const MALE_VOICES = EDGE_VOICE_OPTIONS.filter((v) => v.gender === 'male');

interface ThemeSettingsModalProps {
  variant?: 'inline' | 'overlay';
  isOpen: boolean;
  mode: TranslationMode;
  fontSize: ChatFontSize;
  voiceId: EdgeVoiceId;
  speechRate: number;
  voiceSilenceSeconds: number;
  isPreviewSpeaking: boolean;
  isPreviewLoading: boolean;
  theme: ChatTheme;
  savedThemes: ThemePreset[];
  onModeChange: (mode: TranslationMode) => void;
  onFontSizeLiveChange: (size: ChatFontSize) => void;
  onFontSizeCommit: (size: ChatFontSize) => void;
  onVoiceIdChange: (voiceId: EdgeVoiceId) => void;
  onSpeechRateLiveChange: (rate: number) => void;
  onSpeechRateCommit: (rate: number) => void;
  onVoiceSilenceCommit: (seconds: number) => void;
  onPreviewVoice: () => void;
  onThemeChange: (theme: ChatTheme) => void;
  onSaveCustomTheme: (name: string, theme: ChatTheme) => void;
  onDeleteCustomTheme: (presetId: string) => void;
  onClearChat: () => void;
  onClose: () => void;
}

const CURATED_THEMES: { id: string; label: string; swatch: string; theme: ChatTheme }[] = [
  {
    id: 'default-red',
    label: 'Đỏ mặc định',
    swatch: '#DA0B0B',
    theme: DEFAULT_THEME,
  },
  {
    id: 'ocean-blue',
    label: 'Xanh dương',
    swatch: '#3B82F6',
    theme: {
      accentColor: '#2563EB',
      userBubbleColor: '#1E293B',
      botBubbleColor: '#2563EB',
      chatBgColor: '#F8FAFC',
    },
  },
  {
    id: 'soft-violet',
    label: 'Tím hiện đại',
    swatch: '#9368F7',
    theme: {
      accentColor: '#7C3AED',
      userBubbleColor: '#1F1B2E',
      botBubbleColor: '#7C3AED',
      chatBgColor: '#FAF9FF',
    },
  },
  {
    id: 'emerald-green',
    label: 'Xanh lá',
    swatch: '#2FA66A',
    theme: {
      accentColor: '#16A34A',
      userBubbleColor: '#14261C',
      botBubbleColor: '#2FA66A',
      chatBgColor: '#F7FBF8',
    },
  },
  {
    id: 'warm-amber',
    label: 'Cam ấm',
    swatch: '#EB8324',
    theme: {
      accentColor: '#EA580C',
      userBubbleColor: '#261C17',
      botBubbleColor: '#EA580C',
      chatBgColor: '#FFFBF7',
    },
  },
  {
    id: 'neutral-slate',
    label: 'Xám tối giản',
    swatch: '#7B818E',
    theme: {
      accentColor: '#52525B',
      userBubbleColor: '#18181B',
      botBubbleColor: '#3F3F46',
      chatBgColor: '#FAFAFA',
    },
  },
];

const CUSTOM_PREVIEW_DOTS = ['#DA0B0B', '#F2A3B7', '#60A5FA', '#9D6DF8', '#2FA66A', '#9CA3AF'];

const COLOR_FIELDS: { key: keyof ChatTheme; label: string; hint: string }[] = [
  {
    key: 'accentColor',
    label: 'Màu nút & điểm nhấn',
    hint: 'Nút gửi, thanh kéo, nút gạt',
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

function MicrosoftLogoMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="1" y="1" width="6.5" height="6.5" rx="0.8" fill="#F25022" />
      <rect x="8.5" y="1" width="6.5" height="6.5" rx="0.8" fill="#7FBA00" />
      <rect x="1" y="8.5" width="6.5" height="6.5" rx="0.8" fill="#00A4EF" />
      <rect x="8.5" y="8.5" width="6.5" height="6.5" rx="0.8" fill="#FFB900" />
    </svg>
  );
}

function isSameTheme(a: ChatTheme, b: ChatTheme): boolean {
  return (
    a.accentColor.toLowerCase() === b.accentColor.toLowerCase() &&
    a.userBubbleColor.toLowerCase() === b.userBubbleColor.toLowerCase() &&
    a.botBubbleColor.toLowerCase() === b.botBubbleColor.toLowerCase() &&
    a.chatBgColor.toLowerCase() === b.chatBgColor.toLowerCase()
  );
}

export function ThemeSettingsModal({
  variant = 'overlay',
  isOpen,
  mode,
  fontSize,
  voiceId,
  speechRate,
  voiceSilenceSeconds,
  isPreviewSpeaking,
  isPreviewLoading,
  theme,
  savedThemes,
  onModeChange,
  onFontSizeLiveChange,
  onFontSizeCommit,
  onVoiceIdChange,
  onSpeechRateLiveChange,
  onSpeechRateCommit,
  onVoiceSilenceCommit,
  onPreviewVoice,
  onThemeChange,
  onSaveCustomTheme,
  onDeleteCustomTheme,
  onClearChat,
  onClose,
}: ThemeSettingsModalProps) {
  const [showCustomColors, setShowCustomColors] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Local high-frequency slider states so dragging glides at 60/120fps without parent re-renders
  const [draftFontSize, setDraftFontSize] = useState<number>(fontSize);
  const [draftSpeechRate, setDraftSpeechRate] = useState<number>(speechRate);
  const [draftVoiceSilence, setDraftVoiceSilence] = useState<number>(voiceSilenceSeconds);
  const isDraggingFontRef = useRef(false);
  const isDraggingRateRef = useRef(false);
  const isDraggingSilenceRef = useRef(false);
  const latestFontRef = useRef(fontSize);
  const latestRateRef = useRef(speechRate);
  const latestSilenceRef = useRef(voiceSilenceSeconds);

  useEffect(() => {
    if (!isDraggingFontRef.current) {
      setDraftFontSize(fontSize);
      latestFontRef.current = fontSize;
    }
  }, [fontSize]);

  useEffect(() => {
    if (!isDraggingRateRef.current) {
      setDraftSpeechRate(speechRate);
      latestRateRef.current = speechRate;
    }
  }, [speechRate]);

  useEffect(() => {
    if (!isDraggingSilenceRef.current) {
      setDraftVoiceSilence(voiceSilenceSeconds);
      latestSilenceRef.current = voiceSilenceSeconds;
    }
  }, [voiceSilenceSeconds]);

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

  if (variant === 'overlay' && !isOpen) return null;

  const isFriendly = mode === 'chat';
  const fontPercent = Math.min(
    100,
    Math.max(0, ((draftFontSize - MIN_FONT_SIZE) / (MAX_FONT_SIZE - MIN_FONT_SIZE)) * 100)
  );
  const ratePercent = Math.min(
    100,
    Math.max(0, ((draftSpeechRate - MIN_SPEECH_RATE) / (MAX_SPEECH_RATE - MIN_SPEECH_RATE)) * 100)
  );
  const silencePercent = Math.min(
    100,
    Math.max(
      0,
      ((draftVoiceSilence - MIN_VOICE_SILENCE_SEC) /
        (MAX_VOICE_SILENCE_SEC - MIN_VOICE_SILENCE_SEC)) *
        100
    )
  );
  const formattedFontSize = `${Math.round(draftFontSize)}px`;
  const formattedRate = `${draftSpeechRate.toFixed(2)}x`;
  const formattedSilence = `${(Math.round(draftVoiceSilence * 10) / 10).toFixed(1)}s`;
  const matchesCurated = CURATED_THEMES.some((preset) => isSameTheme(preset.theme, theme));

  const updateField = (key: keyof ChatTheme, value: string) => {
    onThemeChange({
      ...theme,
      [key]: value,
    });
  };

  const handleFontSliderChange = (rawValue: number) => {
    if (!Number.isFinite(rawValue)) return;
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, rawValue));
    latestFontRef.current = clamped;
    setDraftFontSize(clamped);
    onFontSizeLiveChange(clamped);
  };

  const commitFontSlider = () => {
    isDraggingFontRef.current = false;
    onFontSizeCommit(latestFontRef.current);
  };

  const handleRateSliderChange = (rawValue: number) => {
    if (!Number.isFinite(rawValue)) return;
    const clamped = Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rawValue));
    latestRateRef.current = clamped;
    setDraftSpeechRate(clamped);
    onSpeechRateLiveChange(clamped);
  };

  const commitRateSlider = () => {
    isDraggingRateRef.current = false;
    onSpeechRateCommit(latestRateRef.current);
  };

  const handleSilenceSliderChange = (rawValue: number) => {
    if (!Number.isFinite(rawValue)) return;
    const clamped = Math.min(MAX_VOICE_SILENCE_SEC, Math.max(MIN_VOICE_SILENCE_SEC, rawValue));
    latestSilenceRef.current = clamped;
    setDraftVoiceSilence(clamped);
  };

  const commitSilenceSlider = () => {
    isDraggingSilenceRef.current = false;
    onVoiceSilenceCommit(latestSilenceRef.current);
  };

  const handleResetAllDefaults = () => {
    onThemeChange(DEFAULT_THEME);
    setDraftFontSize(DEFAULT_FONT_SIZE_PX);
    latestFontRef.current = DEFAULT_FONT_SIZE_PX;
    onFontSizeLiveChange(DEFAULT_FONT_SIZE_PX);
    onFontSizeCommit(DEFAULT_FONT_SIZE_PX);

    setDraftSpeechRate(1);
    latestRateRef.current = 1;
    onSpeechRateLiveChange(1);
    onSpeechRateCommit(1);

    setDraftVoiceSilence(DEFAULT_VOICE_SILENCE_SEC);
    latestSilenceRef.current = DEFAULT_VOICE_SILENCE_SEC;
    onVoiceSilenceCommit(DEFAULT_VOICE_SILENCE_SEC);

    onModeChange('formal');
  };

  const idPrefix = variant === 'inline' ? 'desktop' : 'mobile';

  const panelContent = (
    <aside
      role={variant === 'overlay' ? 'dialog' : 'complementary'}
      aria-modal={variant === 'overlay' ? true : undefined}
      aria-labelledby={`settings-title-${idPrefix}`}
      className={
        variant === 'inline'
          ? 'w-full h-full bg-white border-l border-[#EAECEF] flex flex-col overflow-hidden'
          : 'settings-drawer-panel w-full sm:w-[400px] h-full bg-white border-l border-[#EAECEF] shadow-2xl flex flex-col overflow-hidden'
      }
    >
      {/* Minimal sticky header */}
      <div className="flex items-center justify-between px-5 sm:px-6 h-[60px] sm:h-[64px] border-b border-[#EFEFF1] pt-[env(safe-area-inset-top)] shrink-0">
        <h2
          id={`settings-title-${idPrefix}`}
          className="text-[17px] font-bold tracking-tight text-[#111111]"
        >
          Cài đặt
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng cài đặt"
          className="flex items-center justify-center w-9 h-9 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-[#F4F5F7] transition-colors cursor-pointer"
        >
          <X className="w-[18px] h-[18px]" strokeWidth={2} />
        </button>
      </div>

      {/* Scrollable single-column body */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6 py-5 space-y-6">
        {/* 1. Giao diện trò chuyện */}
        <section className="space-y-3">
          <div className="flex items-start gap-2.5">
            <MessageSquareMore
              className="w-5 h-5 text-[#111111] mt-0.5 shrink-0"
              strokeWidth={1.9}
            />
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold tracking-tight text-[#111111] leading-snug">
                Giao diện trò chuyện
              </h3>
              <p className="text-[12.5px] text-[#71717A] mt-0.5">
                Điều chỉnh cỡ chữ và phong cách dịch.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#EAECEF] bg-white divide-y divide-[#ECEEF1]">
            {/* Continuous smooth Font Size Slider */}
            <div className="px-4 py-3.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`font-size-slider-${idPrefix}`}
                  className="block text-[13px] font-medium text-[#111111]"
                >
                  Kích thước chữ
                </label>
                <span className="text-[11.5px] text-[#8E8E93] tabular-nums">
                  {MIN_FONT_SIZE}px – {MAX_FONT_SIZE}px
                </span>
              </div>

              <div className="flex items-center gap-3 h-9">
                <input
                  id={`font-size-slider-${idPrefix}`}
                  type="range"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  step="any"
                  value={draftFontSize}
                  onPointerDown={() => {
                    isDraggingFontRef.current = true;
                  }}
                  onChange={(e) => handleFontSliderChange(parseFloat(e.target.value))}
                  onPointerUp={commitFontSlider}
                  onTouchEnd={commitFontSlider}
                  onKeyUp={commitFontSlider}
                  onBlur={commitFontSlider}
                  aria-label="Kích thước chữ khung chat"
                  style={{
                    background: `linear-gradient(to right, var(--cydia-accent) 0%, var(--cydia-accent) ${fontPercent}%, #E5E7EB ${fontPercent}%, #E5E7EB 100%)`,
                  }}
                  className="cydia-slider flex-1 min-w-0 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDraftFontSize(DEFAULT_FONT_SIZE_PX);
                    latestFontRef.current = DEFAULT_FONT_SIZE_PX;
                    onFontSizeLiveChange(DEFAULT_FONT_SIZE_PX);
                    onFontSizeCommit(DEFAULT_FONT_SIZE_PX);
                  }}
                  title={
                    Math.round(draftFontSize) === DEFAULT_FONT_SIZE_PX
                      ? `Cỡ chữ chuẩn ${DEFAULT_FONT_SIZE_PX}px`
                      : `Bấm để về chuẩn ${DEFAULT_FONT_SIZE_PX}px`
                  }
                  className="w-[54px] h-8 px-2 rounded-xl bg-[#F4F5F7] hover:bg-[#EAECEF] text-[13px] font-semibold text-[#111111] tabular-nums transition-colors shrink-0 cursor-pointer text-center"
                >
                  {formattedFontSize}
                </button>
              </div>
            </div>

            {/* Formal / Thân thiện toggle switch */}
            <div className="px-4 py-3.5 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-[#111111]">
                  Phong cách dịch
                </span>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onModeChange('formal')}
                    className={`text-[13px] transition-colors whitespace-nowrap cursor-pointer ${
                      !isFriendly
                        ? 'font-semibold text-[#111111]'
                        : 'font-medium text-[#8E8E93] hover:text-[#52525B]'
                    }`}
                  >
                    Formal
                  </button>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={isFriendly}
                    aria-label="Chuyển giữa phong cách Formal và Thân thiện"
                    onClick={() => onModeChange(isFriendly ? 'formal' : 'chat')}
                    className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-[var(--cydia-accent)] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
                  >
                    <span
                      className={`inline-block h-4.5 w-4.5 transform rounded-full bg-[var(--cydia-switch-knob)] shadow-xs transition-transform duration-150 ${
                        isFriendly ? 'translate-x-5.5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  <button
                    type="button"
                    onClick={() => onModeChange('chat')}
                    className={`text-[13px] transition-colors whitespace-nowrap cursor-pointer ${
                      isFriendly
                        ? 'font-semibold text-[#111111]'
                        : 'font-medium text-[#8E8E93] hover:text-[#52525B]'
                    }`}
                  >
                    Thân thiện
                  </button>
                </div>
              </div>

              <p className="text-[12px] text-[#71717A] leading-snug">
                {isFriendly
                  ? 'Tự nhiên, dùng viết tắt & từ lóng (u, fyi, btw, gonna...)'
                  : 'Lịch sự, chuẩn ngữ pháp cho công việc.'}
              </p>
            </div>
          </div>
        </section>

        {/* 2. Giọng đọc phát âm */}
        <section className="space-y-3">
          <div className="flex items-start gap-2.5">
            <AudioLines
              className="w-5 h-5 text-[#111111] mt-0.5 shrink-0"
              strokeWidth={1.9}
            />
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold tracking-tight text-[#111111] leading-snug">
                Giọng nói &amp; Ghi âm
              </h3>
              <p className="text-[12.5px] text-[#71717A] mt-0.5">
                Chọn giọng đọc, tốc độ nói và thời gian ngắt mic.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#EAECEF] bg-white divide-y divide-[#ECEEF1]">
            {/* Voice selector + preview play button */}
            <div className="px-4 py-3.5 space-y-2">
              <label
                htmlFor={`settings-voice-select-${idPrefix}`}
                className="block text-[13px] font-medium text-[#111111]"
              >
                Giọng nói
              </label>
              <div className="flex items-center gap-2.5">
                <div className="relative flex-1 min-w-0 flex items-center">
                  <span className="pointer-events-none absolute left-3.5 flex items-center">
                    <MicrosoftLogoMark />
                  </span>
                  <select
                    id={`settings-voice-select-${idPrefix}`}
                    value={voiceId}
                    onChange={(e) => onVoiceIdChange(e.target.value as EdgeVoiceId)}
                    className="w-full h-10 appearance-none rounded-full border border-[#E5E7EB] bg-white hover:border-[#D4D4D8] pl-9 pr-9 text-[13.5px] font-medium text-[#111111] focus:outline-none focus:border-[var(--cydia-accent)] transition-colors cursor-pointer"
                  >
                    <optgroup label="Giọng nữ">
                      {FEMALE_VOICES.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Giọng nam">
                      {MALE_VOICES.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-3 w-4 h-4 text-[#52525B]"
                    strokeWidth={2}
                  />
                </div>

                <button
                  type="button"
                  onClick={onPreviewVoice}
                  aria-label={isPreviewSpeaking ? 'Dừng nghe thử' : 'Nghe thử giọng đọc'}
                  title={isPreviewSpeaking ? 'Dừng nghe thử' : 'Nghe thử giọng đọc'}
                  className={`flex items-center justify-center w-10 h-10 rounded-full transition-all cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
                    isPreviewSpeaking
                      ? 'bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)]'
                      : 'bg-[#F4F5F7] hover:bg-[#EAECEF] text-[#111111]'
                  }`}
                >
                  {isPreviewLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.2} />
                  ) : isPreviewSpeaking ? (
                    <Square className="w-3.5 h-3.5 fill-current" strokeWidth={2} />
                  ) : (
                    <Play className="w-4 h-4 fill-current translate-x-[1px]" strokeWidth={2} />
                  )}
                </button>
              </div>
            </div>

            {/* Continuous smooth Speech Rate Slider */}
            <div className="px-4 py-3.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`speech-rate-slider-${idPrefix}`}
                  className="block text-[13px] font-medium text-[#111111]"
                >
                  Tốc độ đọc
                </label>
                <span className="text-[11.5px] text-[#8E8E93] tabular-nums">
                  0.50x – 1.50x
                </span>
              </div>

              <div className="flex items-center gap-3 h-9">
                <input
                  id={`speech-rate-slider-${idPrefix}`}
                  type="range"
                  min={MIN_SPEECH_RATE}
                  max={MAX_SPEECH_RATE}
                  step="any"
                  value={draftSpeechRate}
                  onPointerDown={() => {
                    isDraggingRateRef.current = true;
                  }}
                  onChange={(e) => handleRateSliderChange(parseFloat(e.target.value))}
                  onPointerUp={commitRateSlider}
                  onTouchEnd={commitRateSlider}
                  onKeyUp={commitRateSlider}
                  onBlur={commitRateSlider}
                  aria-label="Tốc độ đọc phát âm"
                  style={{
                    background: `linear-gradient(to right, var(--cydia-accent) 0%, var(--cydia-accent) ${ratePercent}%, #E5E7EB ${ratePercent}%, #E5E7EB 100%)`,
                  }}
                  className="cydia-slider flex-1 min-w-0 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDraftSpeechRate(1);
                    latestRateRef.current = 1;
                    onSpeechRateLiveChange(1);
                    onSpeechRateCommit(1);
                  }}
                  title={
                    Math.abs(draftSpeechRate - 1) < 0.005
                      ? 'Tốc độ chuẩn 1.00x'
                      : 'Bấm để về chuẩn 1.00x'
                  }
                  className="w-[54px] h-8 px-2 rounded-xl bg-[#F4F5F7] hover:bg-[#EAECEF] text-[13px] font-semibold text-[#111111] tabular-nums transition-colors shrink-0 cursor-pointer text-center"
                >
                  {formattedRate}
                </button>
              </div>
            </div>

            {/* Continuous smooth Voice Silence Auto-Stop Slider */}
            <div className="px-4 py-3.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`voice-silence-slider-${idPrefix}`}
                  className="block text-[13px] font-medium text-[#111111]"
                >
                  Tự ngắt ghi âm khi im lặng
                </label>
                <span className="text-[11.5px] text-[#8E8E93] tabular-nums">
                  {MIN_VOICE_SILENCE_SEC}s – {MAX_VOICE_SILENCE_SEC}s
                </span>
              </div>

              <div className="flex items-center gap-3 h-9">
                <input
                  id={`voice-silence-slider-${idPrefix}`}
                  type="range"
                  min={MIN_VOICE_SILENCE_SEC}
                  max={MAX_VOICE_SILENCE_SEC}
                  step="any"
                  value={draftVoiceSilence}
                  onPointerDown={() => {
                    isDraggingSilenceRef.current = true;
                  }}
                  onChange={(e) => handleSilenceSliderChange(parseFloat(e.target.value))}
                  onPointerUp={commitSilenceSlider}
                  onTouchEnd={commitSilenceSlider}
                  onKeyUp={commitSilenceSlider}
                  onBlur={commitSilenceSlider}
                  aria-label="Thời gian tự động ngắt ghi âm khi im lặng"
                  style={{
                    background: `linear-gradient(to right, var(--cydia-accent) 0%, var(--cydia-accent) ${silencePercent}%, #E5E7EB ${silencePercent}%, #E5E7EB 100%)`,
                  }}
                  className="cydia-slider flex-1 min-w-0 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDraftVoiceSilence(DEFAULT_VOICE_SILENCE_SEC);
                    latestSilenceRef.current = DEFAULT_VOICE_SILENCE_SEC;
                    onVoiceSilenceCommit(DEFAULT_VOICE_SILENCE_SEC);
                  }}
                  title={
                    Math.abs(draftVoiceSilence - DEFAULT_VOICE_SILENCE_SEC) < 0.05
                      ? `Mặc định ${DEFAULT_VOICE_SILENCE_SEC}.0s`
                      : `Bấm để về mặc định ${DEFAULT_VOICE_SILENCE_SEC}.0s`
                  }
                  className="w-[54px] h-8 px-2 rounded-xl bg-[#F4F5F7] hover:bg-[#EAECEF] text-[13px] font-semibold text-[#111111] tabular-nums transition-colors shrink-0 cursor-pointer text-center"
                >
                  {formattedSilence}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Màu sắc giao diện */}
        <section className="space-y-3">
          <div className="flex items-start gap-2.5">
            <Palette
              className="w-5 h-5 text-[#111111] mt-0.5 shrink-0"
              strokeWidth={1.9}
            />
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold tracking-tight text-[#111111] leading-snug">
                Màu sắc giao diện
              </h3>
              <p className="text-[12.5px] text-[#71717A] mt-0.5">
                Chọn màu sắc phù hợp với bạn.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#EAECEF] bg-white px-4 py-3.5 space-y-3.5">
            {/* 6 curated circular swatches */}
            <div
              className="flex items-center justify-between gap-2"
              role="radiogroup"
              aria-label="Bảng màu gợi ý"
            >
              {CURATED_THEMES.map((preset) => {
                const active = isSameTheme(preset.theme, theme);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={preset.label}
                    title={preset.label}
                    onClick={() => onThemeChange(preset.theme)}
                    className={`relative flex items-center justify-center w-9 h-9 rounded-full transition-transform hover:scale-105 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
                      active ? 'ring-2 ring-offset-2' : 'ring-1 ring-black/8'
                    }`}
                    style={{
                      backgroundColor: preset.swatch,
                      ...(active ? { ['--tw-ring-color' as string]: preset.swatch } : {}),
                    }}
                  >
                    <span className="sr-only">{preset.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Tùy chỉnh toggle row */}
            <div className="pt-3 border-t border-[#ECEEF1]">
              <button
                type="button"
                onClick={() => setShowCustomColors((prev) => !prev)}
                aria-expanded={showCustomColors}
                className={`w-full flex items-center justify-between gap-3 px-2.5 py-2 -mx-0.5 rounded-xl transition-colors cursor-pointer ${
                  showCustomColors || !matchesCurated ? 'bg-[#F4F5F7]' : 'hover:bg-[#F7F8FA]'
                }`}
              >
                <span className="inline-flex items-center gap-2 text-[13px] font-medium text-[#3F3F46]">
                  <Pipette className="w-3.5 h-3.5" strokeWidth={2} />
                  <span>Tùy chỉnh chi tiết</span>
                </span>
                <span className="flex items-center gap-1.5" aria-hidden="true">
                  {CUSTOM_PREVIEW_DOTS.map((hex) => (
                    <span
                      key={hex}
                      className="w-2.5 h-2.5 rounded-full ring-1 ring-black/10"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </span>
              </button>
            </div>

            {/* Expandable fine-grained color customizer */}
            {showCustomColors && (
              <div className="pt-1 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-[#71717A]">
                    Chọn màu riêng & lưu bộ màu
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onSaveCustomTheme(`Bộ màu ${savedThemes.length + 1}`, theme);
                      setJustSaved(true);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[#E5E7EB] bg-white hover:bg-[#F4F5F7] text-[12px] font-medium text-[#111111] transition-colors cursor-pointer"
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

                {savedThemes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {savedThemes.map((preset) => {
                      const active = isSameTheme(preset.theme, theme);
                      return (
                        <div
                          key={preset.id}
                          className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full border text-[12px] transition-colors ${
                            active
                              ? 'border-[#111111] bg-[#F4F5F7] font-semibold text-[#111111]'
                              : 'border-[#EAECEF] bg-white hover:border-[#D4D4D8] text-[#52525B]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onThemeChange(preset.theme)}
                            className="inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: preset.theme.accentColor }}
                            />
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
                )}

                <div className="divide-y divide-[#F0F0F2] rounded-xl border border-[#EAECEF] bg-white overflow-hidden">
                  {COLOR_FIELDS.map((field) => (
                    <label
                      key={field.key}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-[#FAFAFA] transition-colors cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-[#111111] truncate">
                          {field.label}
                        </div>
                        <div className="text-[11.5px] text-[#8E8E93] truncate">{field.hint}</div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11.5px] font-mono uppercase text-[#71717A] tabular-nums">
                          {theme[field.key]}
                        </span>
                        <input
                          type="color"
                          value={theme[field.key]}
                          onInput={(e) => updateField(field.key, e.currentTarget.value)}
                          onChange={(e) => updateField(field.key, e.target.value)}
                          aria-label={field.label}
                          className="w-7 h-7 rounded-full border border-[#E5E5E7] bg-transparent cursor-pointer overflow-hidden p-0"
                        />
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Sticky footer */}
      <div className="flex items-center justify-between gap-2 px-5 sm:px-6 pt-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] border-t border-[#EFEFF1] bg-white shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onClearChat();
              onClose();
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-full text-[12.5px] font-medium text-[#52525B] hover:text-[#111111] hover:bg-[#F4F5F7] transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
            <span>Làm mới chat</span>
          </button>

          <button
            type="button"
            onClick={handleResetAllDefaults}
            className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-full text-[12.5px] font-medium text-[#52525B] hover:text-[#111111] hover:bg-[#F4F5F7] transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" strokeWidth={2} />
            <span>Mặc định</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            onThemeChange(theme);
            onClose();
          }}
          className="px-6 py-2 rounded-full bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)] text-[13.5px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer shrink-0"
        >
          Xong
        </button>
      </div>
    </aside>
  );

  if (variant === 'inline') {
    return panelContent;
  }

  return (
    <div
      className="settings-drawer-backdrop fixed inset-0 z-50 flex justify-end bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {panelContent}
    </div>
  );
}
