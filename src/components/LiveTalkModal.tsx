import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Captions, Mic, MicOff, PhoneOff, RotateCcw, X } from 'lucide-react';
import { EdgeVoiceId, VoiceGender } from '../types';
import { LiveTalkStatus, LiveTalkTurn, useLiveTalk } from '../hooks/useLiveTalk';

interface LiveTalkModalProps {
  isOpen: boolean;
  voiceId: EdgeVoiceId;
  voiceGender: VoiceGender;
  speechRate: number;
  voiceSilenceSeconds: number;
  onCloseWithTranscript: (turns: LiveTalkTurn[]) => void;
}

function getStatusCaption(status: LiveTalkStatus, isMuted: boolean): string {
  if (status === 'connecting') return 'Đang kết nối...';
  if (status === 'thinking') return 'Đang suy nghĩ...';
  if (status === 'speaking') return 'Đang nói...';
  if (status === 'listening') return isMuted ? 'Đã tắt micro' : 'Đang nghe...';
  return '';
}

export function LiveTalkModal({
  isOpen,
  voiceId,
  voiceGender,
  speechRate,
  voiceSilenceSeconds,
  onCloseWithTranscript,
}: LiveTalkModalProps) {
  const [showSubtitles, setShowSubtitles] = useState(false);
  const clipId = useId();

  const outerRingRef = useRef<HTMLDivElement>(null);
  const innerRingRef = useRef<HTMLDivElement>(null);
  const robotBodyRef = useRef<HTMLDivElement>(null);
  const mouthGroupRef = useRef<SVGGElement>(null);
  const antennaGroupRef = useRef<SVGGElement>(null);
  const endedRef = useRef(false);

  const live = useLiveTalk({
    isOpen,
    voiceId,
    voiceGender,
    speechRate,
    voiceSilenceSeconds,
  });

  // Reset default view (robot only, subtitles toggleable via CC) each time modal opens
  useEffect(() => {
    if (isOpen) {
      endedRef.current = false;
      setShowSubtitles(false);
    }
  }, [isOpen]);

  const handleFinish = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    const turns = live.endSession();
    onCloseWithTranscript(turns);
  }, [live, onCloseWithTranscript]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleFinish();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, handleFinish]);

  // 60fps compositor-only animation driving the exact Cydia logo robot's halo, bounce, antenna & talking grin
  useEffect(() => {
    if (!isOpen) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    let rafId = 0;
    const animate = (now: number) => {
      const level = live.audioLevelRef.current;
      const isSpeaking = live.status === 'speaking';
      const isListening = live.status === 'listening' && !live.isMuted;

      if (outerRingRef.current) {
        const baseScale = isSpeaking ? 1.07 : isListening ? 1.02 : 0.96;
        const scale = baseScale + level * (isSpeaking ? 0.32 : 0.22);
        const opacity = isSpeaking
          ? Math.min(0.32, 0.12 + level * 0.24)
          : isListening
          ? Math.min(0.22, 0.06 + level * 0.18)
          : 0.05;
        outerRingRef.current.style.transform = `scale(${scale.toFixed(3)})`;
        outerRingRef.current.style.opacity = opacity.toFixed(3);
      }

      if (innerRingRef.current) {
        const baseScale = isSpeaking ? 1.03 : isListening ? 1.0 : 0.96;
        const scale = baseScale + level * (isSpeaking ? 0.18 : 0.14);
        const opacity = isSpeaking
          ? Math.min(0.42, 0.15 + level * 0.28)
          : isListening
          ? Math.min(0.26, 0.08 + level * 0.18)
          : 0.07;
        innerRingRef.current.style.transform = `scale(${scale.toFixed(3)})`;
        innerRingRef.current.style.opacity = opacity.toFixed(3);
      }

      if (robotBodyRef.current) {
        const speakBounce = isSpeaking ? -level * 4.5 : 0;
        const scale = isSpeaking ? 1 + level * 0.028 : 1 + level * 0.014;
        robotBodyRef.current.style.transform = `translateY(${speakBounce.toFixed(2)}px) scale(${scale.toFixed(3)})`;
      }

      if (mouthGroupRef.current) {
        if (isSpeaking) {
          const flutter = 0.5 + 0.5 * Math.sin(now * 0.022);
          const openScaleY = 0.78 + level * (0.42 + flutter * 0.28);
          mouthGroupRef.current.style.transform = `scaleY(${openScaleY.toFixed(3)})`;
        } else {
          mouthGroupRef.current.style.transform = 'scaleY(1)';
        }
      }

      if (antennaGroupRef.current) {
        const angle = isSpeaking
          ? Math.sin(now * 0.018) * (4 + level * 9)
          : isListening
          ? Math.sin(now * 0.008) * (1.5 + level * 5)
          : 0;
        antennaGroupRef.current.style.transform = `rotate(${angle.toFixed(2)}deg)`;
      }

      rafId = window.requestAnimationFrame(animate);
    };

    rafId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(rafId);
  }, [isOpen, live.audioLevelRef, live.isMuted, live.status]);

  if (!isOpen) return null;

  const isSpeaking = live.status === 'speaking';
  const isThinkingOrConnecting = live.status === 'connecting' || live.status === 'thinking';
  const isError = live.status === 'error';
  const statusText = getStatusCaption(live.status, live.isMuted);
  const hasAnySubtitle = Boolean(live.userSubtitle || live.assistantSubtitle);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Trò chuyện luyện nói tiếng Anh với robot AI"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          handleFinish();
        }
      }}
      className="settings-drawer-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm p-4"
    >
      <div className="live-modal-enter relative w-full max-w-[376px] rounded-[32px] bg-white border border-[#EAECEF] shadow-[0_24px_70px_-16px_rgba(0,0,0,0.22)] px-6 pt-5 pb-7 flex flex-col items-center">
        {/* Minimal close trigger */}
        <button
          type="button"
          onClick={handleFinish}
          aria-label="Đóng và lưu cuộc trò chuyện"
          className="absolute top-4 right-4 flex items-center justify-center w-9 h-9 rounded-full text-[#71717A] hover:text-[#111111] hover:bg-[#F4F4F5] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)]"
        >
          <X className="w-[18px] h-[18px]" strokeWidth={2} />
        </button>

        {/* Exact Cydia Logo Robot Mascot Centerpiece */}
        <div className="relative mt-4 mb-3 flex items-center justify-center w-[212px] h-[212px] select-none">
          {/* Outer audio-reactive acoustic halo */}
          <div
            ref={outerRingRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-1 rounded-full bg-[#4BB52E] opacity-[0.08] will-change-transform"
          />
          {/* Inner acoustic ring */}
          <div
            ref={innerRingRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-5 rounded-full bg-[#4BB52E] opacity-[0.12] will-change-transform"
          />

          <button
            type="button"
            onClick={() => {
              if (isSpeaking) live.interruptSpeaking();
            }}
            aria-label={isSpeaking ? 'Chạm vào robot để ngắt lời và nói tiếp' : 'Robot luyện nói tiếng Anh'}
            title={isSpeaking ? 'Chạm để ngắt lời robot' : undefined}
            className={`relative z-10 flex items-center justify-center w-[160px] h-[160px] rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4BB52E] ${
              isSpeaking ? 'cursor-pointer' : 'cursor-default'
            }`}
          >
            <div ref={robotBodyRef} className="robot-float will-change-transform">
              <svg
                width="152"
                height="152"
                viewBox="0 0 512 512"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
                className="rounded-full shadow-[0_10px_28px_-8px_rgba(0,0,0,0.22)] ring-[3px] ring-white"
              >
                <defs>
                  <clipPath id={clipId}>
                    <circle cx="256" cy="256" r="256" />
                  </clipPath>
                </defs>

                <g clipPath={`url(#${clipId})`}>
                  {/* Iconic Cydia Logo Green Backdrop */}
                  <rect width="512" height="512" fill="#4BB52E" />

                  {/* Animated Antenna */}
                  <g
                    ref={antennaGroupRef}
                    style={{ transformOrigin: '256px 158px' }}
                  >
                    <path
                      d="M256 158 C252 120 264 96 278 86"
                      fill="none"
                      stroke="#111111"
                      strokeWidth="14"
                      strokeLinecap="round"
                    />
                    <circle
                      cx="286"
                      cy="82"
                      r="24"
                      fill={isError ? '#EF4444' : live.isMuted ? '#A1A1AA' : '#FF5A52'}
                      stroke="#111111"
                      strokeWidth="14"
                    />
                  </g>

                  {/* Iconic Sweat Drop */}
                  <path
                    d="M424 128 C424 128 442 158 442 174 C442 187 434 196 424 196 C414 196 406 187 406 174 C406 158 424 128 424 128 Z"
                    fill="#5BB8F6"
                    stroke="#111111"
                    strokeWidth="12"
                    strokeLinejoin="round"
                  />

                  {/* Neck & Shoulders */}
                  <rect
                    x="218"
                    y="382"
                    width="76"
                    height="52"
                    rx="8"
                    fill="#BDBDBD"
                    stroke="#111111"
                    strokeWidth="14"
                  />
                  <path
                    d="M126 512 C126 436 182 414 256 414 C330 414 386 436 386 512 Z"
                    fill="#F2F2F2"
                    stroke="#111111"
                    strokeWidth="14"
                    strokeLinejoin="round"
                  />

                  {/* Ears */}
                  <rect
                    x="86"
                    y="232"
                    width="44"
                    height="72"
                    rx="14"
                    fill="#BDBDBD"
                    stroke="#111111"
                    strokeWidth="14"
                  />
                  <rect
                    x="382"
                    y="232"
                    width="44"
                    height="72"
                    rx="14"
                    fill="#BDBDBD"
                    stroke="#111111"
                    strokeWidth="14"
                  />

                  {/* Head */}
                  <rect
                    x="118"
                    y="156"
                    width="276"
                    height="232"
                    rx="46"
                    fill="#F2F2F2"
                    stroke="#111111"
                    strokeWidth="15"
                  />

                  {/* Eyebrows */}
                  <path
                    d="M150 194 L232 212"
                    fill="none"
                    stroke="#111111"
                    strokeWidth="12"
                    strokeLinecap="round"
                  />
                  <path
                    d="M282 190 Q320 166 360 192"
                    fill="none"
                    stroke="#111111"
                    strokeWidth="12"
                    strokeLinecap="round"
                  />

                  {/* Eyes — exact logo shapes with live state expressions */}
                  {isError ? (
                    <g stroke="#111111" strokeWidth="13" strokeLinecap="round">
                      <path d="M174 236 L218 280 M218 236 L174 280" />
                      <path d="M298 228 L342 272 M342 228 L298 272" />
                    </g>
                  ) : live.isMuted ? (
                    <g stroke="#111111" strokeWidth="13" strokeLinecap="round">
                      <path d="M160 256 L232 256" />
                      <path d="M284 252 L356 252" />
                    </g>
                  ) : (
                    <g className={isThinkingOrConnecting ? '' : 'robot-eye-blink'}>
                      {/* Left half-lidded eye */}
                      <path
                        d="M152 244 L238 232 C240 264 220 286 196 286 C170 286 150 268 152 244 Z"
                        fill="#FFFFFF"
                        stroke="#111111"
                        strokeWidth="12"
                        strokeLinejoin="round"
                      />
                      <circle
                        cx={isThinkingOrConnecting ? '210' : '204'}
                        cy={isThinkingOrConnecting ? '252' : '259'}
                        r="17"
                        fill="#111111"
                      />

                      {/* Right wide eye */}
                      <circle
                        cx="320"
                        cy="248"
                        r="44"
                        fill="#FFFFFF"
                        stroke="#111111"
                        strokeWidth="13"
                      />
                      <circle
                        cx={isThinkingOrConnecting ? '332' : '305'}
                        cy={isThinkingOrConnecting ? '234' : '236'}
                        r="18"
                        fill="#111111"
                      />
                    </g>
                  )}

                  {/* Iconic Toothy Grin — animates smoothly when speaking */}
                  <g
                    ref={mouthGroupRef}
                    style={{ transformOrigin: '256px 338px' }}
                  >
                    {isSpeaking ? (
                      <>
                        {/* Open animated mouth while talking */}
                        <path
                          d="M160 310 Q256 322 352 310 C346 364 310 382 256 382 C202 382 166 364 160 310 Z"
                          fill="#1F1F23"
                          stroke="#111111"
                          strokeWidth="12"
                          strokeLinejoin="round"
                        />
                        {/* Top row of signature white robot teeth */}
                        <path
                          d="M170 315 Q256 324 342 315 L336 336 Q256 344 176 336 Z"
                          fill="#FFFFFF"
                          stroke="#111111"
                          strokeWidth="8"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M210 319 L210 336 M256 321 L256 338 M302 319 L302 336"
                          fill="none"
                          stroke="#111111"
                          strokeWidth="7"
                          strokeLinecap="round"
                        />
                        {/* Friendly warm tongue hint */}
                        <path
                          d="M216 367 Q256 348 296 367 Q256 378 216 367 Z"
                          fill="#FF6B63"
                        />
                      </>
                    ) : (
                      <>
                        <path
                          d="M158 310 Q256 326 354 310 C348 358 310 374 256 374 C202 374 164 358 158 310 Z"
                          fill="#FFFFFF"
                          stroke="#111111"
                          strokeWidth="12"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M196 322 L196 358 M226 324 L226 365 M256 325 L256 366 M286 324 L286 365 M316 322 L316 358"
                          fill="none"
                          stroke="#111111"
                          strokeWidth="9"
                          strokeLinecap="round"
                        />
                      </>
                    )}
                  </g>
                </g>
              </svg>
            </div>
          </button>
        </div>

        {/* Quiet status caption or inline error recovery */}
        {isError ? (
          <div className="mt-1 mb-5 text-center space-y-2.5 px-2">
            <p className="text-[13.5px] text-red-600 leading-snug">
              {live.error || 'Không thể kết nối cuộc trò chuyện.'}
            </p>
            <button
              type="button"
              onClick={live.retry}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#111111] text-white text-[13px] font-medium hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" strokeWidth={2.2} />
              <span>Thử lại</span>
            </button>
          </div>
        ) : (
          <p className="text-[13px] font-medium text-[#71717A] tracking-tight h-5">
            {statusText}
          </p>
        )}

        {/* Optional Toggleable Live Subtitles — displays BOTH User & Robot speech */}
        {showSubtitles && !isError && (
          <div
            aria-live="polite"
            className="mt-3 w-full min-h-[52px] max-h-32 overflow-y-auto px-1.5 space-y-2 text-left"
          >
            {hasAnySubtitle ? (
              <>
                {live.userSubtitle && (
                  <p className="text-[13.5px] leading-[1.45] text-[#111111]">
                    <span className="font-semibold text-[var(--cydia-accent)] mr-1.5">
                      Bạn:
                    </span>
                    <span>{live.userSubtitle}</span>
                  </p>
                )}
                {live.assistantSubtitle && (
                  <p className="text-[13.5px] leading-[1.45] text-[#3F3F46]">
                    <span className="font-semibold text-[#111111] mr-1.5">
                      Robot:
                    </span>
                    <span>{live.assistantSubtitle}</span>
                  </p>
                )}
              </>
            ) : (
              <p className="text-[12.5px] text-[#A1A1AA] text-center">
                Phụ đề phần bạn nói và robot trả lời sẽ hiện ở đây...
              </p>
            )}
          </div>
        )}

        {/* Minimal Ergonomic 3-Button Call Control Bar */}
        <div className="mt-6 flex items-center justify-center gap-5">
          {/* Mute / Unmute Mic */}
          <button
            type="button"
            disabled={isError}
            onClick={live.toggleMute}
            aria-label={live.isMuted ? 'Bật micro' : 'Tắt micro'}
            aria-pressed={live.isMuted}
            title={live.isMuted ? 'Bật micro' : 'Tắt micro'}
            className={`flex items-center justify-center w-[52px] h-[52px] rounded-full transition-all duration-150 active:scale-95 disabled:opacity-40 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
              live.isMuted
                ? 'bg-[#111111] text-white'
                : 'bg-[#F4F4F5] text-[#111111] hover:bg-[#EAECEF]'
            }`}
          >
            {live.isMuted ? (
              <MicOff className="w-5 h-5" strokeWidth={2} />
            ) : (
              <Mic className="w-5 h-5" strokeWidth={2} />
            )}
          </button>

          {/* End Call & Save Conversation */}
          <button
            type="button"
            onClick={handleFinish}
            aria-label="Kết thúc cuộc trò chuyện"
            title="Kết thúc & lưu vào khung chat"
            className="flex items-center justify-center w-[58px] h-[58px] rounded-full bg-[#DC2626] text-white hover:bg-[#B91C1C] active:scale-95 transition-all duration-150 shadow-md shadow-red-600/20 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC2626]"
          >
            <PhoneOff className="w-[22px] h-[22px]" strokeWidth={2.1} />
          </button>

          {/* Toggle Live Subtitles (CC) */}
          <button
            type="button"
            onClick={() => setShowSubtitles((prev) => !prev)}
            aria-label={showSubtitles ? 'Ẩn phụ đề' : 'Hiện phụ đề'}
            aria-pressed={showSubtitles}
            title={showSubtitles ? 'Ẩn phụ đề' : 'Bật phụ đề'}
            className={`flex items-center justify-center w-[52px] h-[52px] rounded-full transition-all duration-150 active:scale-95 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cydia-accent)] ${
              showSubtitles
                ? 'bg-[var(--cydia-accent)] text-[var(--cydia-accent-text)]'
                : 'bg-[#F4F4F5] text-[#111111] hover:bg-[#EAECEF]'
            }`}
          >
            <Captions className="w-5 h-5" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
