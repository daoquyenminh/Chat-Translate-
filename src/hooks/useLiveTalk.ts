import { useCallback, useEffect, useRef, useState } from 'react';
import { EdgeVoiceId, VoiceGender } from '../types';
import { createPlayableAudioUrl } from '../utils/audio';

export type LiveTalkStatus = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface LiveTalkTurn {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface LiveTalkSubtitle {
  role: 'user' | 'assistant';
  text: string;
}

interface UseLiveTalkOptions {
  isOpen: boolean;
  voiceId: EdgeVoiceId;
  voiceGender: VoiceGender;
  speechRate: number;
  voiceSilenceSeconds: number;
}

export interface UseLiveTalkResult {
  status: LiveTalkStatus;
  isMuted: boolean;
  userSubtitle: string;
  assistantSubtitle: string;
  audioLevelRef: React.MutableRefObject<number>;
  error: string | null;
  toggleMute: () => void;
  interruptSpeaking: () => void;
  retry: () => void;
  endSession: () => LiveTalkTurn[];
}

interface SpeechRecognitionPreviewLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: {
    results: {
      length: number;
      [idx: number]: { 0?: { transcript?: string } };
    };
  }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
  SpeechRecognition?: new () => SpeechRecognitionPreviewLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionPreviewLike;
}

const TARGET_INPUT_SAMPLE_RATE = 16000;
const OUTPUT_PCM_SAMPLE_RATE = 24000;
const LIVE_CONNECT_TIMEOUT_MS = 5500;

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext ?? null;
}

function downsampleTo16k(samples: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_INPUT_SAMPLE_RATE) return samples;
  const ratio = inputRate / TARGET_INPUT_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const low = Math.floor(srcIdx);
    const high = Math.min(samples.length - 1, low + 1);
    const frac = srcIdx - low;
    out[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }
  return out;
}

function float32ToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  const chunkSize = 0x4000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLength = binary.length;
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const sampleCount = Math.floor(byteLength / 2);
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return 'audio/webm';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('READ_AUDIO_FAILED'));
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function appendTranscriptDelta(prev: string, delta: string): string {
  if (!delta) return prev;
  if (!prev) return delta.trimStart();
  // Avoid double spaces while preserving natural word separation
  const needsSpace =
    !/\s$/.test(prev) &&
    !/^[\s.,!?;:'")\]]/.test(delta) &&
    /[A-Za-z0-9À-ỹ]$/.test(prev) &&
    /^[A-Za-z0-9À-ỹ]/.test(delta);
  return needsSpace ? `${prev} ${delta}` : `${prev}${delta}`;
}

export function useLiveTalk({
  isOpen,
  voiceId,
  voiceGender,
  speechRate,
  voiceSilenceSeconds,
}: UseLiveTalkOptions): UseLiveTalkResult {
  const [status, setStatus] = useState<LiveTalkStatus>('connecting');
  const [isMuted, setIsMuted] = useState(false);
  const [userSubtitle, setUserSubtitle] = useState('');
  const [assistantSubtitle, setAssistantSubtitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const audioLevelRef = useRef(0);
  const statusRef = useRef<LiveTalkStatus>('connecting');
  const isMutedRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  const sessionIdRef = useRef(0);
  const modeRef = useRef<'live-ws' | 'fallback-turn' | null>(null);

  const voiceIdRef = useRef(voiceId);
  const voiceGenderRef = useRef(voiceGender);
  const speechRateRef = useRef(speechRate);
  const silenceMsRef = useRef(Math.max(1500, Math.round(voiceSilenceSeconds * 1000)));
  voiceIdRef.current = voiceId;
  voiceGenderRef.current = voiceGender;
  speechRateRef.current = speechRate;
  silenceMsRef.current = Math.max(1500, Math.round(voiceSilenceSeconds * 1000));

  // Shared conversation transcript buffer
  const turnsRef = useRef<LiveTalkTurn[]>([]);
  const pendingUserRef = useRef('');
  const pendingAssistantRef = useRef('');

  // Shared mic & animation refs
  const micStreamRef = useRef<MediaStream | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const inputLevelRef = useRef(0);

  // Primary Gemini Live WebSocket refs
  const wsRef = useRef<WebSocket | null>(null);
  const connectTimerRef = useRef<number | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const inputProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputDataRef = useRef<Float32Array | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const speakingEndTimerRef = useRef<number | null>(null);

  // Fallback hands-free turn loop refs
  const fallbackAbortRef = useRef<AbortController | null>(null);
  const fallbackRecorderRef = useRef<MediaRecorder | null>(null);
  const fallbackVadCtxRef = useRef<AudioContext | null>(null);
  const fallbackVadRafRef = useRef<number | null>(null);
  const fallbackAudioElRef = useRef<HTMLAudioElement | null>(null);
  const fallbackAudioUrlRef = useRef<string | null>(null);
  const fallbackPlayCtxRef = useRef<AudioContext | null>(null);
  const fallbackPlayAnalyserRef = useRef<AnalyserNode | null>(null);
  const fallbackPlayDataRef = useRef<Float32Array | null>(null);
  const fallbackSpeakResolveRef = useRef<(() => void) | null>(null);
  const previewRecRef = useRef<SpeechRecognitionPreviewLike | null>(null);

  const setStatusSync = useCallback((next: LiveTalkStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const flushPendingTurn = useCallback((role: 'user' | 'assistant') => {
    const ref = role === 'user' ? pendingUserRef : pendingAssistantRef;
    const cleaned = ref.current.replace(/\s+/g, ' ').trim();
    ref.current = '';
    if (!cleaned) return;
    turnsRef.current.push({
      role,
      text: cleaned,
      createdAt: new Date().toISOString(),
    });
  }, []);

  const stopOutputAudioQueue = useCallback(() => {
    if (speakingEndTimerRef.current !== null) {
      window.clearTimeout(speakingEndTimerRef.current);
      speakingEndTimerRef.current = null;
    }
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Ignore already stopped nodes
      }
    }
    activeSourcesRef.current.clear();
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const stopFallbackAudioElement = useCallback(() => {
    if (fallbackAudioElRef.current) {
      fallbackAudioElRef.current.onended = null;
      fallbackAudioElRef.current.onerror = null;
      try {
        fallbackAudioElRef.current.pause();
      } catch {
        // Ignore
      }
      fallbackAudioElRef.current = null;
    }
    if (fallbackAudioUrlRef.current) {
      URL.revokeObjectURL(fallbackAudioUrlRef.current);
      fallbackAudioUrlRef.current = null;
    }
    if (fallbackPlayCtxRef.current) {
      fallbackPlayCtxRef.current.close().catch(() => {});
      fallbackPlayCtxRef.current = null;
    }
    fallbackPlayAnalyserRef.current = null;
    fallbackPlayDataRef.current = null;
    if (fallbackSpeakResolveRef.current) {
      const done = fallbackSpeakResolveRef.current;
      fallbackSpeakResolveRef.current = null;
      done();
    }
  }, []);

  const stopFallbackRecorder = useCallback(() => {
    if (previewRecRef.current) {
      const rec = previewRecRef.current;
      previewRecRef.current = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // Ignore preview stop errors
      }
    }
    if (fallbackVadRafRef.current !== null) {
      window.cancelAnimationFrame(fallbackVadRafRef.current);
      fallbackVadRafRef.current = null;
    }
    if (fallbackVadCtxRef.current) {
      fallbackVadCtxRef.current.close().catch(() => {});
      fallbackVadCtxRef.current = null;
    }
    if (fallbackRecorderRef.current) {
      const rec = fallbackRecorderRef.current;
      fallbackRecorderRef.current = null;
      rec.onstop = null;
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // Ignore
        }
      }
    }
  }, []);

  const cleanupLiveTransport = useCallback(() => {
    if (connectTimerRef.current !== null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (wsRef.current) {
      const sock = wsRef.current;
      wsRef.current = null;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close();
      } catch {
        // Ignore
      }
    }
    if (inputProcessorRef.current) {
      inputProcessorRef.current.onaudioprocess = null;
      try {
        inputProcessorRef.current.disconnect();
      } catch {
        // Ignore
      }
      inputProcessorRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    stopOutputAudioQueue();
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }
    outputAnalyserRef.current = null;
    outputDataRef.current = null;
  }, [stopOutputAudioQueue]);

  const cleanupEverything = useCallback(
    (releaseMic: boolean) => {
      cleanupLiveTransport();
      stopFallbackRecorder();
      stopFallbackAudioElement();
      if (fallbackAbortRef.current) {
        fallbackAbortRef.current.abort();
        fallbackAbortRef.current = null;
      }
      if (meterRafRef.current !== null) {
        window.cancelAnimationFrame(meterRafRef.current);
        meterRafRef.current = null;
      }
      if (releaseMic && micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
      inputLevelRef.current = 0;
      audioLevelRef.current = 0;
    },
    [cleanupLiveTransport, stopFallbackAudioElement, stopFallbackRecorder]
  );

  // 60fps smooth audio level meter for the robot animation
  const startMeterLoop = useCallback((runId: number) => {
    if (meterRafRef.current !== null) {
      window.cancelAnimationFrame(meterRafRef.current);
    }

    const tick = () => {
      if (sessionIdRef.current !== runId || !isOpenRef.current) {
        meterRafRef.current = null;
        return;
      }

      let target = 0;
      const st = statusRef.current;
      if (st === 'speaking') {
        const analyser =
          modeRef.current === 'live-ws'
            ? outputAnalyserRef.current
            : fallbackPlayAnalyserRef.current;
        const buf =
          modeRef.current === 'live-ws'
            ? outputDataRef.current
            : fallbackPlayDataRef.current;
        if (analyser && buf) {
          analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            sumSq += buf[i] * buf[i];
          }
          const rms = Math.sqrt(sumSq / buf.length);
          target = Math.min(1, rms * 5.2);
        }
      } else if (st === 'listening' && !isMutedRef.current) {
        target = Math.min(1, inputLevelRef.current * 4.5);
      }

      audioLevelRef.current = audioLevelRef.current * 0.7 + target * 0.3;
      meterRafRef.current = window.requestAnimationFrame(tick);
    };

    meterRafRef.current = window.requestAnimationFrame(tick);
  }, []);

  // Fallback Mode: hands-free conversational loop (STT -> /api/practice-turn -> /api/tts)
  const startFallbackTurnLoop = useCallback(
    async (runId: number, stream: MediaStream) => {
      if (sessionIdRef.current !== runId || !isOpenRef.current) return;
      cleanupLiveTransport();
      modeRef.current = 'fallback-turn';

      const speakFallbackReply = async (replyText: string): Promise<void> => {
        if (sessionIdRef.current !== runId || !isOpenRef.current) return;
        setAssistantSubtitle(replyText);
        setStatusSync('speaking');

        const controller = new AbortController();
        fallbackAbortRef.current = controller;

        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              text: replyText,
              voiceId: voiceIdRef.current,
              voiceGender: voiceGenderRef.current,
            }),
          });
          if (!res.ok) throw new Error(`TTS_HTTP_${res.status}`);
          const data = (await res.json()) as { audioBase64?: string; mimeType?: string };
          if (!data.audioBase64) throw new Error('TTS_EMPTY');
          if (sessionIdRef.current !== runId || !isOpenRef.current) return;

          const url = createPlayableAudioUrl(data.audioBase64, data.mimeType || 'audio/mpeg');
          fallbackAudioUrlRef.current = url;
          const audio = new Audio(url);
          audio.playbackRate = speechRateRef.current;
          fallbackAudioElRef.current = audio;

          // Attach AnalyserNode to drive robot voice mouth in fallback mode
          try {
            const AudioCtx = getAudioContextCtor();
            if (AudioCtx) {
              const playCtx = new AudioCtx();
              fallbackPlayCtxRef.current = playCtx;
              if (playCtx.state === 'suspended') {
                await playCtx.resume().catch(() => {});
              }
              const source = playCtx.createMediaElementSource(audio);
              const analyser = playCtx.createAnalyser();
              analyser.fftSize = 512;
              analyser.smoothingTimeConstant = 0.65;
              source.connect(analyser);
              analyser.connect(playCtx.destination);
              fallbackPlayAnalyserRef.current = analyser;
              fallbackPlayDataRef.current = new Float32Array(analyser.fftSize);
            }
          } catch {
            // Audio still plays even if MediaElementSource fails
          }

          await new Promise<void>((resolve) => {
            fallbackSpeakResolveRef.current = resolve;
            const finish = () => {
              stopFallbackAudioElement();
            };
            audio.onended = finish;
            audio.onerror = finish;
            audio.play().catch(finish);
          });
        } catch (err: unknown) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          // Brief pause so user can read subtitle even if TTS fails transiently
          await new Promise((r) => setTimeout(r, 1200));
        } finally {
          if (fallbackAbortRef.current === controller) {
            fallbackAbortRef.current = null;
          }
          stopFallbackAudioElement();
        }
      };

      const listenOnceAndRespond = async (): Promise<void> => {
        if (sessionIdRef.current !== runId || !isOpenRef.current) return;

        // If muted, wait gently until unmuted
        if (isMutedRef.current) {
          setStatusSync('listening');
          return;
        }

        stopFallbackRecorder();
        setStatusSync('listening');

        const mimeType = pickRecorderMimeType();
        let recorder: MediaRecorder;
        try {
          recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
        } catch {
          setError('Trình duyệt không hỗ trợ ghi âm trên thiết bị này.');
          setStatusSync('error');
          return;
        }

        fallbackRecorderRef.current = recorder;
        const chunks: Blob[] = [];
        let hasSpeech = false;
        let lastVoiceAt = Date.now();
        let noiseFloor = 0.012;
        let floorCount = 0;

        recorder.ondataavailable = (ev: BlobEvent) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        };

        const recordedBlob = await new Promise<Blob | null>((resolve) => {
          recorder.onstop = () => {
            stopFallbackRecorder();
            if (sessionIdRef.current !== runId || !isOpenRef.current) {
              resolve(null);
              return;
            }
            const blob = new Blob(chunks, {
              type: recorder.mimeType || mimeType || 'audio/webm',
            });
            resolve(hasSpeech && blob.size > 500 ? blob : null);
          };

          try {
            recorder.start(220);
          } catch {
            stopFallbackRecorder();
            resolve(null);
            return;
          }

          // Safe best-effort live interim subtitle preview of user's voice while speaking
          try {
            const win = window as WindowWithWebkitAudio;
            const SpeechCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
            if (SpeechCtor) {
              const previewRec = new SpeechCtor();
              previewRec.continuous = true;
              previewRec.interimResults = true;
              previewRec.lang = 'en-US';
              previewRec.onresult = (ev) => {
                if (
                  sessionIdRef.current !== runId ||
                  !isOpenRef.current ||
                  previewRecRef.current !== previewRec
                ) {
                  return;
                }
                let liveLine = '';
                for (let i = 0; i < ev.results.length; i++) {
                  const piece = ev.results[i]?.[0]?.transcript ?? '';
                  if (piece) liveLine += `${piece} `;
                }
                const cleaned = liveLine.replace(/\s+/g, ' ').trim();
                if (cleaned) {
                  setUserSubtitle(cleaned);
                }
              };
              previewRec.onerror = () => {
                // Silent fallback: MediaRecorder + /api/stt remains authoritative
              };
              previewRec.onend = () => {
                if (previewRecRef.current === previewRec) {
                  previewRecRef.current = null;
                }
              };
              previewRecRef.current = previewRec;
              previewRec.start();
            }
          } catch {
            previewRecRef.current = null;
          }

          try {
            const AudioCtx = getAudioContextCtor();
            if (AudioCtx) {
              const vadCtx = new AudioCtx();
              fallbackVadCtxRef.current = vadCtx;
              const src = vadCtx.createMediaStreamSource(stream);
              const analyser = vadCtx.createAnalyser();
              analyser.fftSize = 1024;
              src.connect(analyser);
              const buf = new Float32Array(analyser.fftSize);

              const checkVad = () => {
                if (
                  sessionIdRef.current !== runId ||
                  !isOpenRef.current ||
                  fallbackRecorderRef.current !== recorder
                ) {
                  return;
                }
                if (isMutedRef.current) {
                  inputLevelRef.current = 0;
                  if (recorder.state !== 'inactive') {
                    hasSpeech = false;
                    try {
                      recorder.stop();
                    } catch {
                      // Ignore
                    }
                  }
                  return;
                }

                analyser.getFloatTimeDomainData(buf);
                let sumSq = 0;
                for (let i = 0; i < buf.length; i++) {
                  sumSq += buf[i] * buf[i];
                }
                const rms = Math.sqrt(sumSq / buf.length);
                inputLevelRef.current = rms;

                if (floorCount < 15) {
                  noiseFloor = (noiseFloor * floorCount + rms) / (floorCount + 1);
                  floorCount++;
                }

                const threshold = Math.max(0.018, Math.min(0.065, noiseFloor * 2.5));
                const now = Date.now();
                if (rms >= threshold) {
                  hasSpeech = true;
                  lastVoiceAt = now;
                } else if (hasSpeech && now - lastVoiceAt >= silenceMsRef.current) {
                  if (recorder.state !== 'inactive') {
                    try {
                      recorder.stop();
                    } catch {
                      // Ignore
                    }
                  }
                  return;
                }

                fallbackVadRafRef.current = window.requestAnimationFrame(checkVad);
              };

              fallbackVadRafRef.current = window.requestAnimationFrame(checkVad);
            }
          } catch {
            // If AudioContext fails, stop after 6s chunks
            window.setTimeout(() => {
              if (fallbackRecorderRef.current === recorder && recorder.state !== 'inactive') {
                hasSpeech = true;
                recorder.stop();
              }
            }, 6000);
          }
        });

        inputLevelRef.current = 0;
        if (sessionIdRef.current !== runId || !isOpenRef.current) return;
        if (isMutedRef.current) return;

        if (!recordedBlob) {
          void listenOnceAndRespond();
          return;
        }

        setStatusSync('thinking');
        const controller = new AbortController();
        fallbackAbortRef.current = controller;

        try {
          const audioBase64 = await blobToBase64(recordedBlob);
          const sttRes = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              audioBase64,
              mimeType: recordedBlob.type || 'audio/webm',
            }),
          });
          const sttJson = (await sttRes.json().catch(() => ({}))) as { text?: string };
          const userText = typeof sttJson.text === 'string' ? sttJson.text.trim() : '';

          if (!userText) {
            void listenOnceAndRespond();
            return;
          }

          if (sessionIdRef.current !== runId || !isOpenRef.current) return;
          turnsRef.current.push({
            role: 'user',
            text: userText,
            createdAt: new Date().toISOString(),
          });
          setUserSubtitle(userText);

          const turnRes = await fetch('/api/practice-turn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              history: turnsRef.current.map((t) => ({ role: t.role, text: t.text })),
            }),
          });
          const turnJson = (await turnRes.json().catch(() => ({}))) as {
            reply?: string;
            error?: string;
          };
          if (!turnRes.ok || !turnJson.reply) {
            throw new Error(turnJson.error || 'Không thể phản hồi lúc này.');
          }

          if (sessionIdRef.current !== runId || !isOpenRef.current) return;
          const reply = turnJson.reply.trim();
          turnsRef.current.push({
            role: 'assistant',
            text: reply,
            createdAt: new Date().toISOString(),
          });

          await speakFallbackReply(reply);
          if (sessionIdRef.current === runId && isOpenRef.current && !isMutedRef.current) {
            void listenOnceAndRespond();
          } else if (sessionIdRef.current === runId && isOpenRef.current) {
            setStatusSync('listening');
          }
        } catch (err: unknown) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          if (sessionIdRef.current !== runId || !isOpenRef.current) return;
          setError(
            err instanceof Error && err.message
              ? err.message
              : 'Mất kết nối với robot. Vui lòng thử lại.'
          );
          setStatusSync('error');
        } finally {
          if (fallbackAbortRef.current === controller) {
            fallbackAbortRef.current = null;
          }
        }
      };

      resumeFallbackListenRef.current = () => {
        if (sessionIdRef.current === runId && isOpenRef.current && !isMutedRef.current) {
          void listenOnceAndRespond();
        }
      };

      // Kick off session with a warm native English greeting
      setStatusSync('connecting');
      const greetCtrl = new AbortController();
      fallbackAbortRef.current = greetCtrl;
      try {
        const res = await fetch('/api/practice-turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: greetCtrl.signal,
          body: JSON.stringify({ history: [] }),
        });
        const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
        if (!res.ok || !data.reply) {
          throw new Error(data.error || 'Không thể kết nối robot luyện nói lúc này.');
        }
        if (sessionIdRef.current !== runId || !isOpenRef.current) return;
        const greeting = data.reply.trim();
        turnsRef.current.push({
          role: 'assistant',
          text: greeting,
          createdAt: new Date().toISOString(),
        });
        await speakFallbackReply(greeting);
        if (sessionIdRef.current === runId && isOpenRef.current) {
          void listenOnceAndRespond();
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        if (sessionIdRef.current !== runId || !isOpenRef.current) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'Không thể kết nối robot luyện nói lúc này.'
        );
        setStatusSync('error');
      } finally {
        if (fallbackAbortRef.current === greetCtrl) {
          fallbackAbortRef.current = null;
        }
      }
    },
    [
      cleanupLiveTransport,
      setStatusSync,
      stopFallbackAudioElement,
      stopFallbackRecorder,
    ]
  );

  // Store fallback resume ref so unmuting or interrupting in fallback mode immediately listens
  const resumeFallbackListenRef = useRef<(() => void) | null>(null);

  const startSession = useCallback(async () => {
    const runId = ++sessionIdRef.current;
    cleanupEverything(true);
    turnsRef.current = [];
    pendingUserRef.current = '';
    pendingAssistantRef.current = '';
    isMutedRef.current = false;
    setIsMuted(false);
    setUserSubtitle('');
    setAssistantSubtitle('');
    setError(null);
    setStatusSync('connecting');

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setError('Trình duyệt hiện tại không hỗ trợ truy cập micro.');
      setStatusSync('error');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err: unknown) {
      if (sessionIdRef.current !== runId || !isOpenRef.current) return;
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Chưa được cấp quyền micro — hãy cho phép micro để trò chuyện.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('Không tìm thấy thiết bị micro trên máy.');
      } else {
        setError('Không thể mở micro lúc này.');
      }
      setStatusSync('error');
      return;
    }

    if (sessionIdRef.current !== runId || !isOpenRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    micStreamRef.current = stream;
    startMeterLoop(runId);

    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) {
      void startFallbackTurnLoop(runId, stream);
      return;
    }

    // Primary Engine: True Full-Duplex Gemini Live API WebSocket
    modeRef.current = 'live-ws';
    let liveReady = false;
    let switchedToFallback = false;

    const triggerFallback = () => {
      if (switchedToFallback || sessionIdRef.current !== runId || !isOpenRef.current) return;
      switchedToFallback = true;
      void startFallbackTurnLoop(runId, stream);
    };

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/api/live-talk?voiceGender=${encodeURIComponent(
      voiceGenderRef.current
    )}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      triggerFallback();
      return;
    }

    wsRef.current = ws;

    connectTimerRef.current = window.setTimeout(() => {
      if (!liveReady && sessionIdRef.current === runId && isOpenRef.current) {
        triggerFallback();
      }
    }, LIVE_CONNECT_TIMEOUT_MS);

    const scheduleOutputPcm = (base64Pcm: string) => {
      let outCtx = outputAudioCtxRef.current;
      if (!outCtx) {
        try {
          outCtx = new AudioContext({ sampleRate: OUTPUT_PCM_SAMPLE_RATE });
        } catch {
          outCtx = new AudioCtx();
        }
        outputAudioCtxRef.current = outCtx;
        const analyser = outCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.65;
        analyser.connect(outCtx.destination);
        outputAnalyserRef.current = analyser;
        outputDataRef.current = new Float32Array(analyser.fftSize);
        nextStartTimeRef.current = outCtx.currentTime;
      }

      if (outCtx.state === 'suspended') {
        void outCtx.resume().catch(() => {});
      }

      const samples = pcm16Base64ToFloat32(base64Pcm);
      if (samples.length === 0) return;

      const buffer = outCtx.createBuffer(1, samples.length, OUTPUT_PCM_SAMPLE_RATE);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);

      const src = outCtx.createBufferSource();
      src.buffer = buffer;
      if (outputAnalyserRef.current) {
        src.connect(outputAnalyserRef.current);
      } else {
        src.connect(outCtx.destination);
      }

      const now = outCtx.currentTime;
      const startAt = Math.max(now + 0.012, nextStartTimeRef.current);
      nextStartTimeRef.current = startAt + buffer.duration;

      activeSourcesRef.current.add(src);
      src.onended = () => {
        activeSourcesRef.current.delete(src);
      };

      try {
        src.start(startAt);
      } catch {
        activeSourcesRef.current.delete(src);
        return;
      }

      if (statusRef.current !== 'speaking') {
        setStatusSync('speaking');
      }

      if (speakingEndTimerRef.current !== null) {
        window.clearTimeout(speakingEndTimerRef.current);
      }
      const remainingMs = Math.max(120, Math.ceil((nextStartTimeRef.current - outCtx.currentTime) * 1000) + 80);
      speakingEndTimerRef.current = window.setTimeout(() => {
        speakingEndTimerRef.current = null;
        if (
          sessionIdRef.current === runId &&
          isOpenRef.current &&
          activeSourcesRef.current.size === 0 &&
          statusRef.current === 'speaking'
        ) {
          setStatusSync('listening');
        }
      }, remainingMs);
    };

    const startMicPcmPipeline = () => {
      if (inputAudioCtxRef.current || !micStreamRef.current) return;
      let inCtx: AudioContext;
      try {
        inCtx = new AudioContext({ sampleRate: TARGET_INPUT_SAMPLE_RATE });
      } catch {
        inCtx = new AudioCtx();
      }
      inputAudioCtxRef.current = inCtx;
      if (inCtx.state === 'suspended') {
        void inCtx.resume().catch(() => {});
      }

      const source = inCtx.createMediaStreamSource(micStreamRef.current);
      const processor = inCtx.createScriptProcessor(4096, 1, 1);
      inputProcessorRef.current = processor;

      // Silent gain node keeps ScriptProcessor running without mic feedback echo
      const muteGain = inCtx.createGain();
      muteGain.gain.value = 0;

      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(inCtx.destination);

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (
          sessionIdRef.current !== runId ||
          !isOpenRef.current ||
          wsRef.current !== ws ||
          ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        if (isMutedRef.current) {
          inputLevelRef.current = 0;
          return;
        }

        const rawChannel = event.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < rawChannel.length; i++) {
          sumSq += rawChannel[i] * rawChannel[i];
        }
        inputLevelRef.current = Math.sqrt(sumSq / rawChannel.length);

        const pcm16k = downsampleTo16k(rawChannel, inCtx.sampleRate);
        const base64 = float32ToPcm16Base64(pcm16k);
        try {
          ws.send(JSON.stringify({ type: 'audio', data: base64 }));
        } catch {
          // Ignore send failures while closing
        }
      };
    };

    ws.onmessage = (event: MessageEvent) => {
      if (sessionIdRef.current !== runId || !isOpenRef.current || switchedToFallback) return;
      let msg: { type?: string; data?: string; text?: string; error?: string } | null = null;
      try {
        msg = JSON.parse(String(event.data)) as {
          type?: string;
          data?: string;
          text?: string;
          error?: string;
        };
      } catch {
        return;
      }
      if (!msg) return;

      if (msg.type === 'ready') {
        liveReady = true;
        if (connectTimerRef.current !== null) {
          window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        startMicPcmPipeline();
        setStatusSync('thinking');
        try {
          ws.send(JSON.stringify({ type: 'greet' }));
        } catch {
          // Ignore
        }
        return;
      }

      if (msg.type === 'audio' && typeof msg.data === 'string') {
        if (pendingUserRef.current.trim()) {
          flushPendingTurn('user');
        }
        scheduleOutputPcm(msg.data);
        return;
      }

      if (msg.type === 'inputTranscript' && typeof msg.text === 'string') {
        if (pendingAssistantRef.current.trim()) {
          flushPendingTurn('assistant');
        }
        pendingUserRef.current = appendTranscriptDelta(pendingUserRef.current, msg.text);
        setUserSubtitle(pendingUserRef.current.replace(/\s+/g, ' ').trim());
        return;
      }

      if (msg.type === 'outputTranscript' && typeof msg.text === 'string') {
        if (pendingUserRef.current.trim()) {
          flushPendingTurn('user');
        }
        pendingAssistantRef.current = appendTranscriptDelta(pendingAssistantRef.current, msg.text);
        setAssistantSubtitle(pendingAssistantRef.current.replace(/\s+/g, ' ').trim());
        return;
      }

      if (msg.type === 'interrupted') {
        stopOutputAudioQueue();
        flushPendingTurn('assistant');
        setStatusSync('listening');
        return;
      }

      if (msg.type === 'turnComplete') {
        flushPendingTurn('user');
        flushPendingTurn('assistant');
        if (activeSourcesRef.current.size === 0) {
          setStatusSync('listening');
        }
        return;
      }

      if (msg.type === 'error') {
        if (!liveReady || turnsRef.current.length === 0) {
          triggerFallback();
        } else {
          setError(msg.error || 'Kết nối giọng nói bị gián đoạn.');
          setStatusSync('error');
        }
      }
    };

    ws.onerror = () => {
      if (!liveReady || turnsRef.current.length === 0) {
        triggerFallback();
      }
    };

    ws.onclose = () => {
      if (switchedToFallback || sessionIdRef.current !== runId || !isOpenRef.current) return;
      if (!liveReady || turnsRef.current.length === 0) {
        triggerFallback();
      } else if (statusRef.current !== 'error') {
        setError('Phiên trò chuyện đã ngắt kết nối.');
        setStatusSync('error');
      }
    };
  }, [
    cleanupEverything,
    flushPendingTurn,
    setStatusSync,
    startFallbackTurnLoop,
    startMeterLoop,
    stopOutputAudioQueue,
  ]);

  useEffect(() => {
    isOpenRef.current = isOpen;
    if (isOpen) {
      void startSession();
    } else {
      sessionIdRef.current++;
      cleanupEverything(true);
    }
    return () => {
      sessionIdRef.current++;
      cleanupEverything(true);
    };
  }, [isOpen, startSession, cleanupEverything]);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMutedRef.current;
    isMutedRef.current = nextMuted;
    setIsMuted(nextMuted);

    // In fallback mode, unmuting while idle restarts the turn listener cleanly
    if (!nextMuted && modeRef.current === 'fallback-turn' && statusRef.current === 'listening') {
      if (micStreamRef.current && !fallbackRecorderRef.current) {
        const runId = sessionIdRef.current;
        // Trigger a fresh listen cycle via retry-free lightweight restart if needed
        if (resumeFallbackListenRef.current) {
          resumeFallbackListenRef.current();
        } else {
          // Restart listening without re-greeting by resuming stream
          void (async () => {
            if (sessionIdRef.current !== runId || !micStreamRef.current) return;
            await startFallbackTurnLoop(runId, micStreamRef.current);
          })();
        }
      }
    }
  }, [startFallbackTurnLoop]);

  const interruptSpeaking = useCallback(() => {
    if (statusRef.current !== 'speaking') return;
    if (modeRef.current === 'live-ws') {
      stopOutputAudioQueue();
      setStatusSync('listening');
    } else if (modeRef.current === 'fallback-turn') {
      stopFallbackAudioElement();
      setStatusSync('listening');
    }
  }, [setStatusSync, stopFallbackAudioElement, stopOutputAudioQueue]);

  const retry = useCallback(() => {
    void startSession();
  }, [startSession]);

  const endSession = useCallback((): LiveTalkTurn[] => {
    flushPendingTurn('user');
    flushPendingTurn('assistant');
    const captured = [...turnsRef.current];
    turnsRef.current = [];
    sessionIdRef.current++;
    cleanupEverything(true);
    return captured;
  }, [cleanupEverything, flushPendingTurn]);

  return {
    status,
    isMuted,
    userSubtitle,
    assistantSubtitle,
    audioLevelRef,
    error,
    toggleMute,
    interruptSpeaking,
    retry,
    endSession,
  };
}
