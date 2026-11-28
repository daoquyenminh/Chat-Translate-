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
    new Blob([rawBytes.buffer as ArrayBuffer], { type: mimeType || 'audio/wav' })
  );
}
