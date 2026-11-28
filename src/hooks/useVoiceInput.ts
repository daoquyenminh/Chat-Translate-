import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceInputStatus = 'idle' | 'listening' | 'transcribing';
export type VoiceInputEngine = 'browser' | 'ai' | null;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionInstanceLike {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstanceLike;

interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  webkitAudioContext?: typeof AudioContext;
}

interface UseVoiceInputOptions {
  silenceTimeoutMs?: number;
  onTranscriptChange: (mergedText: string) => void;
  onBeforeStart?: () => void;
}

export interface UseVoiceInputResult {
  status: VoiceInputStatus;
  engine: VoiceInputEngine;
  error: string | null;
  isSupported: boolean;
  toggleListening: (currentDraft: string) => void;
  stopListening: () => void;
  clearError: () => void;
}

const DEFAULT_SILENCE_TIMEOUT_MS = 3000;
const SILENCE_POLL_MS = 120;
const FALLBACK_TO_AI_ERRORS = new Set([
  'service-not-allowed',
  'network',
  'language-not-supported',
]);

function getBrowserSpeechCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as WindowWithSpeech;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function canUseMediaRecorder(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'
  );
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
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('READ_AUDIO_FAILED'));
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function mergeDraftWithSpeech(baseDraft: string, speechText: string): string {
  const cleanSpeech = speechText.replace(/\s+/g, ' ').trim();
  if (!cleanSpeech) return baseDraft;
  const trimmedBase = baseDraft.trimEnd();
  if (!trimmedBase) return cleanSpeech;
  return `${trimmedBase} ${cleanSpeech}`;
}

export function useVoiceInput({
  silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
  onTranscriptChange,
  onBeforeStart,
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceInputStatus>('idle');
  const [engine, setEngine] = useState<VoiceInputEngine>(null);
  const [error, setError] = useState<string | null>(null);

  const statusRef = useRef<VoiceInputStatus>('idle');
  const baseDraftRef = useRef('');
  const committedTextRef = useRef('');
  const interimTextRef = useRef('');
  const lastActivityAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const hasSpeechRef = useRef(false);
  const manualStopRef = useRef(false);
  const silenceTimeoutMsRef = useRef(Math.max(500, silenceTimeoutMs));
  silenceTimeoutMsRef.current = Math.max(500, silenceTimeoutMs);

  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);
  const silenceIntervalRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  // AI MediaRecorder fallback refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRafRef = useRef<number | null>(null);
  const sttAbortRef = useRef<AbortController | null>(null);

  const onTranscriptChangeRef = useRef(onTranscriptChange);
  const onBeforeStartRef = useRef(onBeforeStart);
  onTranscriptChangeRef.current = onTranscriptChange;
  onBeforeStartRef.current = onBeforeStart;

  const setStatusSync = useCallback((next: VoiceInputStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const flashError = useCallback((message: string) => {
    setError(message);
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
    }
    errorTimerRef.current = window.setTimeout(() => {
      setError(null);
      errorTimerRef.current = null;
    }, 4000);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  const clearSilenceMonitor = useCallback(() => {
    if (silenceIntervalRef.current !== null) {
      window.clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
  }, []);

  const releaseMediaResources = useCallback(() => {
    if (vadRafRef.current !== null) {
      window.cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const stopAll = useCallback(
    (abortPendingStt = false) => {
      manualStopRef.current = true;
      clearSilenceMonitor();

      if (recognitionRef.current) {
        const rec = recognitionRef.current;
        recognitionRef.current = null;
        try {
          rec.stop();
        } catch {
          try {
            rec.abort();
          } catch {
            // Ignore cleanup errors
          }
        }
      }

      if (mediaRecorderRef.current) {
        const recorder = mediaRecorderRef.current;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Ignore stop errors
          }
        }
      }

      if (abortPendingStt && sttAbortRef.current) {
        sttAbortRef.current.abort();
        sttAbortRef.current = null;
      }

      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        releaseMediaResources();
        if (statusRef.current === 'listening') {
          setStatusSync('idle');
          setEngine(null);
        }
      }
    },
    [clearSilenceMonitor, releaseMediaResources, setStatusSync]
  );

  const startAiRecorder = useCallback(
    async (baseDraft: string) => {
      if (!canUseMediaRecorder()) {
        setStatusSync('idle');
        setEngine(null);
        flashError('Trình duyệt này chưa hỗ trợ ghi âm nhận diện giọng nói.');
        return;
      }

      baseDraftRef.current = baseDraft;
      audioChunksRef.current = [];
      hasSpeechRef.current = false;
      manualStopRef.current = false;
      clearError();

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
        setStatusSync('idle');
        setEngine(null);
        const name = (err as { name?: string })?.name ?? '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          flashError('Chưa được cấp quyền micro — hãy cho phép micro để nói.');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          flashError('Không tìm thấy thiết bị micro.');
        } else {
          flashError('Không thể mở micro lúc này.');
        }
        return;
      }

      mediaStreamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch {
        releaseMediaResources();
        setStatusSync('idle');
        setEngine(null);
        flashError('Trình duyệt không hỗ trợ định dạng ghi âm này.');
        return;
      }

      mediaRecorderRef.current = recorder;
      const now = Date.now();
      startedAtRef.current = now;
      lastActivityAtRef.current = now;
      setEngine('ai');
      setStatusSync('listening');

      // Set up Web Audio AnalyserNode for live wave level + adaptive 3-second silence detection
      try {
        const AudioCtx = window.AudioContext ?? (window as WindowWithSpeech).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.7;
          source.connect(analyser);

          const samples = new Float32Array(analyser.fftSize);
          let noiseFloor = 0.01;
          let floorSamples = 0;

          const tickVad = () => {
            if (statusRef.current !== 'listening' || !mediaRecorderRef.current) {
              vadRafRef.current = null;
              return;
            }
            analyser.getFloatTimeDomainData(samples);
            let sumSq = 0;
            for (let i = 0; i < samples.length; i++) {
              sumSq += samples[i] * samples[i];
            }
            const rms = Math.sqrt(sumSq / samples.length);

            // Calibrate ambient noise during first ~250ms
            if (floorSamples < 15) {
              noiseFloor = (noiseFloor * floorSamples + rms) / (floorSamples + 1);
              floorSamples++;
            }

            const threshold = Math.max(0.016, Math.min(0.06, noiseFloor * 2.4));

            const t = Date.now();
            if (rms >= threshold) {
              lastActivityAtRef.current = t;
              hasSpeechRef.current = true;
            } else {
              const silentMs = t - lastActivityAtRef.current;
              if (silentMs >= silenceTimeoutMsRef.current) {
                clearSilenceMonitor();
                if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                  try {
                    mediaRecorderRef.current.stop();
                  } catch {
                    // Ignore
                  }
                }
                vadRafRef.current = null;
                return;
              }
            }

            vadRafRef.current = window.requestAnimationFrame(tickVad);
          };

          vadRafRef.current = window.requestAnimationFrame(tickVad);
        }
      } catch {
        // Fallback silence timeout if AudioContext is restricted
        clearSilenceMonitor();
        silenceIntervalRef.current = window.setInterval(() => {
          const silentMs = Date.now() - lastActivityAtRef.current;
          if (silentMs >= silenceTimeoutMsRef.current) {
            clearSilenceMonitor();
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              mediaRecorderRef.current.stop();
            }
          }
        }, SILENCE_POLL_MS);
      }

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        mediaRecorderRef.current = null;
        clearSilenceMonitor();
        releaseMediaResources();

        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        const durationMs = Date.now() - startedAtRef.current;
        const blobType = recorder.mimeType || mimeType || 'audio/webm';
        const audioBlob = new Blob(chunks, { type: blobType });

        // Skip sending if practically empty or completely silent
        if (audioBlob.size < 400 || (!hasSpeechRef.current && durationMs < 900)) {
          setStatusSync('idle');
          setEngine(null);
          if (!manualStopRef.current) {
            flashError('Chưa nghe rõ giọng nói, hãy thử lại.');
          }
          return;
        }

        setStatusSync('transcribing');
        const controller = new AbortController();
        sttAbortRef.current = controller;

        try {
          const audioBase64 = await blobToBase64(audioBlob);
          const res = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              audioBase64,
              mimeType: blobType,
            }),
          });

          const data = (await res.json().catch(() => ({}))) as {
            text?: string;
            error?: string;
          };

          if (!res.ok) {
            throw new Error(data.error || 'Không thể nhận diện giọng nói lúc này.');
          }

          const transcript = typeof data.text === 'string' ? data.text.trim() : '';
          if (transcript) {
            onTranscriptChangeRef.current(mergeDraftWithSpeech(baseDraftRef.current, transcript));
          } else {
            flashError('Chưa nghe rõ giọng nói, hãy thử lại.');
          }
        } catch (err: unknown) {
          if ((err as { name?: string })?.name !== 'AbortError') {
            flashError(
              err instanceof Error && err.message
                ? err.message
                : 'Không thể nhận diện giọng nói lúc này.'
            );
          }
        } finally {
          if (sttAbortRef.current === controller) {
            sttAbortRef.current = null;
          }
          setStatusSync('idle');
          setEngine(null);
        }
      };

      try {
        recorder.start(250);
      } catch {
        mediaRecorderRef.current = null;
        releaseMediaResources();
        setStatusSync('idle');
        setEngine(null);
        flashError('Không thể bắt đầu ghi âm.');
      }
    },
    [
      clearError,
      clearSilenceMonitor,
      flashError,
      releaseMediaResources,
      setStatusSync,
    ]
  );

  const startBrowserSpeech = useCallback(
    (baseDraft: string) => {
      const SpeechCtor = getBrowserSpeechCtor();
      if (!SpeechCtor) {
        void startAiRecorder(baseDraft);
        return;
      }

      baseDraftRef.current = baseDraft;
      committedTextRef.current = '';
      interimTextRef.current = '';
      hasSpeechRef.current = false;
      manualStopRef.current = false;
      clearError();

      const recognition = new SpeechCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      // vi-VN recognizes Vietnamese and embedded English words smoothly on Chrome/Edge/Safari
      recognition.lang = 'vi-VN';
      recognitionRef.current = recognition;

      let lastTextSignature = '';
      let switchedToAiFallback = false;

      const touchActivity = () => {
        lastActivityAtRef.current = Date.now();
      };

      const startSilenceTimer = () => {
        clearSilenceMonitor();
        lastActivityAtRef.current = Date.now();
        silenceIntervalRef.current = window.setInterval(() => {
          if (statusRef.current !== 'listening' || recognitionRef.current !== recognition) {
            clearSilenceMonitor();
            return;
          }
          const silentMs = Date.now() - lastActivityAtRef.current;
          if (silentMs >= silenceTimeoutMsRef.current) {
            clearSilenceMonitor();
            try {
              recognition.stop();
            } catch {
              // Ignore
            }
          }
        }, SILENCE_POLL_MS);
      };

      recognition.onstart = () => {
        if (recognitionRef.current !== recognition) return;
        startedAtRef.current = Date.now();
        setEngine('browser');
        setStatusSync('listening');
        startSilenceTimer();
      };

      recognition.onspeechstart = () => {
        if (recognitionRef.current !== recognition) return;
        hasSpeechRef.current = true;
        touchActivity();
      };

      recognition.onsoundstart = () => {
        if (recognitionRef.current !== recognition) return;
        touchActivity();
      };

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        if (recognitionRef.current !== recognition) return;

        let nextFinal = '';
        let nextInterim = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result?.[0]?.transcript ?? '';
          if (!text) continue;
          if (result.isFinal) {
            nextFinal += `${text} `;
          } else {
            nextInterim += text;
          }
        }

        const combined = `${nextFinal}${nextInterim}`.replace(/\s+/g, ' ').trim();
        if (combined !== lastTextSignature) {
          lastTextSignature = combined;
          hasSpeechRef.current = Boolean(combined);
          committedTextRef.current = nextFinal.trim();
          interimTextRef.current = nextInterim.trim();
          touchActivity();
          onTranscriptChangeRef.current(mergeDraftWithSpeech(baseDraftRef.current, combined));
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (recognitionRef.current !== recognition) return;
        const code = event.error ?? '';

        if (code === 'aborted' || code === 'no-speech') {
          return;
        }

        if (FALLBACK_TO_AI_ERRORS.has(code) && !hasSpeechRef.current && canUseMediaRecorder()) {
          switchedToAiFallback = true;
          recognitionRef.current = null;
          clearSilenceMonitor();
          try {
            recognition.abort();
          } catch {
            // Ignore
          }
          void startAiRecorder(baseDraftRef.current);
          return;
        }

        clearSilenceMonitor();
        recognitionRef.current = null;
        setStatusSync('idle');
        setEngine(null);

        if (code === 'not-allowed') {
          flashError('Chưa được cấp quyền micro — hãy cho phép micro để nói.');
        } else if (code === 'audio-capture') {
          flashError('Không tìm thấy thiết bị micro.');
        } else {
          flashError('Không thể nhận diện giọng nói lúc này.');
        }
      };

      recognition.onend = () => {
        if (switchedToAiFallback) return;
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }
        clearSilenceMonitor();

        const finalCombined = `${committedTextRef.current} ${interimTextRef.current}`
          .replace(/\s+/g, ' ')
          .trim();
        if (finalCombined) {
          onTranscriptChangeRef.current(mergeDraftWithSpeech(baseDraftRef.current, finalCombined));
        } else if (!manualStopRef.current && statusRef.current === 'listening') {
          flashError('Chưa nghe rõ giọng nói, hãy thử lại.');
        }

        setStatusSync('idle');
        setEngine(null);
      };

      try {
        recognition.start();
      } catch {
        recognitionRef.current = null;
        void startAiRecorder(baseDraft);
      }
    },
    [clearError, clearSilenceMonitor, flashError, setStatusSync, startAiRecorder]
  );

  const toggleListening = useCallback(
    (currentDraft: string) => {
      if (statusRef.current === 'transcribing') return;
      if (statusRef.current === 'listening') {
        stopAll(false);
        return;
      }

      onBeforeStartRef.current?.();
      startBrowserSpeech(currentDraft);
    },
    [startBrowserSpeech, stopAll]
  );

  const stopListening = useCallback(() => {
    if (statusRef.current === 'listening') {
      stopAll(false);
    }
  }, [stopAll]);

  useEffect(() => {
    return () => {
      stopAll(true);
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
      }
    };
  }, [stopAll]);

  const isSupported = Boolean(getBrowserSpeechCtor() || canUseMediaRecorder());

  return {
    status,
    engine,
    error,
    isSupported,
    toggleListening,
    stopListening,
    clearError,
  };
}
