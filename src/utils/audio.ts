function base64ToUint8Array(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hasRiffHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

function wrapPcm16AsWav(pcmBytes: Uint8Array, sampleRate = 24000): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, pcmBytes.length, true);

  const wav = new Uint8Array(44 + pcmBytes.length);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcmBytes, 44);
  return wav;
}

export function createPlayableAudioUrl(base64: string, mimeType?: string): string {
  const rawBytes = base64ToUint8Array(base64);
  const lowerMime = (mimeType || '').toLowerCase();

  if (hasRiffHeader(rawBytes)) {
    return URL.createObjectURL(new Blob([rawBytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
  }

  if (lowerMime.includes('l16') || lowerMime.includes('pcm')) {
    const rateMatch = lowerMime.match(/rate=(\d+)/);
    const rate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
    const wavBytes = wrapPcm16AsWav(rawBytes, rate);
    return URL.createObjectURL(new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
  }

  return URL.createObjectURL(
    new Blob([rawBytes.buffer as ArrayBuffer], { type: mimeType || 'audio/mpeg' })
  );
}

const FEMALE_VOICE_HINTS = [
  'samantha',
  'ava',
  'allison',
  'susan',
  'victoria',
  'karen',
  'moira',
  'tessa',
  'aria',
  'jenny',
  'sara',
  'zira',
  'google us english',
  'female',
];

const MALE_VOICE_HINTS = [
  'alex',
  'daniel',
  'tom',
  'aaron',
  'fred',
  'oliver',
  'arthur',
  'guy',
  'davis',
  'andrew',
  'christopher',
  'david',
  'mark',
  'male',
];

function pickEnglishBrowserVoice(
  voices: SpeechSynthesisVoice[],
  gender: 'female' | 'male'
): SpeechSynthesisVoice | null {
  const enVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  if (enVoices.length === 0) return null;

  const preferred = gender === 'male' ? MALE_VOICE_HINTS : FEMALE_VOICE_HINTS;
  const opposite = gender === 'male' ? FEMALE_VOICE_HINTS : MALE_VOICE_HINTS;

  const scoreVoice = (voice: SpeechSynthesisVoice): number => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase();
    let score = 0;

    if (lang === 'en-us') score += 30;
    else if (lang.startsWith('en-us')) score += 25;
    else if (lang === 'en-gb') score += 15;
    else score += 5;

    if (name.includes('natural') || name.includes('enhanced') || name.includes('premium')) {
      score += 20;
    }

    const prefIdx = preferred.findIndex((hint) => name.includes(hint));
    if (prefIdx !== -1) {
      score += 50 - prefIdx;
    }

    if (opposite.some((hint) => name.includes(hint))) {
      score -= 35;
    }

    return score;
  };

  return [...enVoices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

export function stopBrowserVoice(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore synthesis cancel errors
  }
}

export function speakWithBrowserVoice(
  text: string,
  gender: 'female' | 'male',
  callbacks?: {
    rate?: number;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: () => void;
    onBoundary?: (start: number, end: number) => void;
  }
): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    callbacks?.onError?.();
    return false;
  }

  const synth = window.speechSynthesis;
  try {
    synth.cancel();
  } catch {
    // Ignore cancel errors
  }

  const rawRate = typeof callbacks?.rate === 'number' && Number.isFinite(callbacks.rate)
    ? callbacks.rate
    : 1;
  const clampedRate = Math.min(1.5, Math.max(0.5, rawRate));

  const startSpeaking = () => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = clampedRate;
    utterance.pitch = gender === 'male' ? 0.94 : 1.03;

    const picked = pickEnglishBrowserVoice(synth.getVoices(), gender);
    if (picked) {
      utterance.voice = picked;
      utterance.lang = picked.lang || 'en-US';
    }

    utterance.onstart = () => callbacks?.onStart?.();
    utterance.onend = () => callbacks?.onEnd?.();
    utterance.onerror = () => callbacks?.onError?.();
    if (callbacks?.onBoundary) {
      utterance.onboundary = (event: SpeechSynthesisEvent) => {
        if (event.name && event.name !== 'word') return;
        const start = event.charIndex;
        if (typeof start !== 'number' || start < 0 || start >= text.length) return;
        let end =
          typeof event.charLength === 'number' && event.charLength > 0
            ? Math.min(text.length, start + event.charLength)
            : start;
        if (end <= start) {
          end = start;
          while (end < text.length && !/\s/.test(text[end])) {
            end++;
          }
          while (end > start + 1 && /[.,!?;:)"'\]]/.test(text[end - 1])) {
            end--;
          }
        }
        if (end > start) {
          callbacks.onBoundary?.(start, end);
        }
      };
    }

    synth.speak(utterance);
  };

  if (synth.getVoices().length > 0) {
    startSpeaking();
    return true;
  }

  let started = false;
  const launchOnce = () => {
    if (started) return;
    started = true;
    synth.removeEventListener('voiceschanged', launchOnce);
    startSpeaking();
  };

  synth.addEventListener('voiceschanged', launchOnce);
  window.setTimeout(launchOnce, 180);
  return true;
}
