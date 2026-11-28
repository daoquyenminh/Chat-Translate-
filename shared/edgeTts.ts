import { VoiceGender } from './prompts';

export interface EdgeSpeechResult {
  audioBytes: Uint8Array;
  mimeType: string;
}

export interface EdgeSocketLike {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onTextMessage(cb: (text: string) => void): void;
  onBinaryMessage(cb: (bytes: Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}

export interface EdgeSocketConnectOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export type EdgeSocketConnector = (
  options: EdgeSocketConnectOptions
) => Promise<EdgeSocketLike>;

const BASE_HOST = 'speech.platform.bing.com';
const BASE_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export const EDGE_TTS_VOICES: Record<VoiceGender, string> = {
  female: 'en-US-AvaNeural',
  male: 'en-US-AndrewNeural',
};

const WIN_EPOCH = 11644473600n;
const TICKS_PER_SECOND = 10_000_000n;

const SHA256_INITIAL: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_STATE: readonly number[] = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];

const SHA256_SCHEDULE: readonly number[] = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];

const SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS: readonly number[] = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];

const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];

const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

let clockSkewSeconds = 0;

export function adjustEdgeClockSkewFromDateHeader(dateHeader: string | null | undefined): boolean {
  if (!dateHeader) return false;
  const parsedMs = Date.parse(dateHeader);
  if (!Number.isFinite(parsedMs)) return false;
  const serverSec = parsedMs / 1000;
  const clientSec = Date.now() / 1000 + clockSkewSeconds;
  clockSkewSeconds += serverSec - clientSec;
  return true;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function rol16(value: number): number {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function sigma0(v: number): number {
  return (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0;
}

function sigma1(v: number): number {
  return (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0;
}

function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    const s1 = sigma1(words[i - 2]);
    const s0 = sigma0(words[i - 15]);
    words[i] = (s1 + words[i - 7] + s0 + words[i - 16]) >>> 0;
  }
}

function sha256Rounds(
  state: readonly number[],
  words: readonly number[],
  firstRound = 0
): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;

  for (let i = firstRound; i < 64; i++) {
    const bigSigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const t1 = (h + bigSigma1 + ch + constants[i] + words[i]) >>> 0;
    const bigSigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t2 = (bigSigma0 + maj) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }

  return [a, b, c, d, e, f, g, h];
}

function sha256Init(prefix7: Uint8Array): number[] {
  const words = new Array<number>(64).fill(0);
  words[14] = ((prefix7[0] << 16) | (prefix7[1] << 8) | prefix7[2]) >>> 0;
  words[15] =
    ((prefix7[3] << 24) | (prefix7[4] << 16) | (prefix7[5] << 8) | prefix7[6]) >>> 0;

  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      const s1 = sigma1(words[i - 2]);
      value = (value + (i === 16 ? (s1 ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : s1)) >>> 0;
    }
    if (i - 7 >= 14) {
      value = (value + words[i - 7]) >>> 0;
    }
    if (i - 15 >= 14) {
      const s0 = sigma0(words[i - 15]);
      value = (value + (i === 29 ? (s0 ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : s0)) >>> 0;
    }
    words[i] = value >>> 0;
  }

  words[30] =
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
    0;

  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function sha256DigestV2(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const tail = data.subarray(7);
  const padZeros = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.length + 1 + padZeros + 8);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const bitLen = BigInt(length) * 8n;
  view.setUint32(padded.length - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(padded.length - 4, Number(bitLen & 0xffffffffn), false);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Array<number>(64);
    for (let i = 0; i < 16; i++) {
      words[i] = view.getUint32(offset + i * 4, false);
    }
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, state[i], false);
  }
  return out;
}

function wordsLe4Even(data: Uint8Array): number[] {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = new Uint8Array(data.length + pad);
  padded.set(data, 0);
  const view = new DataView(padded.buffer);
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(view.getUint32(i, true));
  }
  if (words.length % 2 === 1) {
    words.push(0);
  }
  return words;
}

function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = (digestView.getUint32(0, true) | 1) >>> 0;
  const keyB = (digestView.getUint32(4, true) | 1) >>> 0;

  const factorA = Math.imul(keyA, CS64_FACTOR) >>> 0;
  const factorB = Math.imul(keyB, CS64_FACTOR) >>> 0;

  const terms: number[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < CS64_COEFFICIENTS.length; i++) {
    const [coeff, offset] = CS64_COEFFICIENTS[i];
    terms.push(Math.imul(coeff, i % 2 === 0 ? factorA : factorB) >>> 0);
    offsets.push(offset >>> 0);
  }

  const prefixed = new Uint8Array(1 + data.length);
  prefixed[0] = 0;
  prefixed.set(data, 1);
  const inputWords = wordsLe4Even(prefixed);

  for (let i = 0; i < inputWords.length; i++) {
    const word = inputWords[i];
    let term = Math.imul(word, i % 2 === 0 ? keyA : keyB) >>> 0;
    let offset = Math.imul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db) >>> 0;
    if (i === 0) {
      term = (term + Math.imul(CS64_ADJUSTMENT0, factorA)) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;

  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];

    let t = rol16((offsets[i] + x) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;

    t = rol16((offsets[i + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;

    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function bytesToUpperHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

export function generateSecMsGecV2(unixSeconds?: number): string {
  const sec = unixSeconds ?? Date.now() / 1000 + clockSkewSeconds;
  let ticks = BigInt(Math.floor(sec)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= TICKS_PER_SECOND;

  const ascii = `${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`;
  const data = new Uint8Array(ascii.length);
  for (let i = 0; i < ascii.length; i++) {
    data[i] = ascii.charCodeAt(i);
  }

  const shaDigest = sha256DigestV2(data);
  const [csA, csB] = cs64Digest(data, shaDigest);
  const csBytes = new Uint8Array(8);
  const csView = new DataView(csBytes.buffer);
  csView.setUint32(0, csA, true);
  csView.setUint32(4, csB, true);

  return `${bytesToUpperHex(csBytes)}-${bytesToUpperHex(shaDigest)}`;
}

function randomHex16Bytes(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToUpperHex(bytes);
}

function formatEdgeTimestamp(): string {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function escapeXmlForSsml(input: string): string {
  const safe = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return safe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) {
    total += c.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

const edgeTtsCache = new Map<string, EdgeSpeechResult>();
const EDGE_CACHE_MAX = 60;

function getCachedEdgeTts(key: string): EdgeSpeechResult | undefined {
  const hit = edgeTtsCache.get(key);
  if (!hit) return undefined;
  edgeTtsCache.delete(key);
  edgeTtsCache.set(key, hit);
  return hit;
}

function setCachedEdgeTts(key: string, value: EdgeSpeechResult): void {
  if (edgeTtsCache.size >= EDGE_CACHE_MAX) {
    const oldest = edgeTtsCache.keys().next().value;
    if (oldest) edgeTtsCache.delete(oldest);
  }
  edgeTtsCache.set(key, value);
}

export function buildEdgeTtsConnection(scheme: 'wss' | 'https' = 'wss'): {
  url: string;
  headers: Record<string, string>;
  connectionId: string;
} {
  const connectionId = randomHex16Bytes().toLowerCase();
  const muid = randomHex16Bytes();
  const gec = generateSecMsGecV2();
  const url = `${scheme}://${BASE_HOST}${BASE_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

  const headers: Record<string, string> = {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${muid};`,
  };

  return { url, headers, connectionId };
}

export async function synthesizeWithEdgeTts(
  options: {
    text: string;
    voiceGender?: VoiceGender;
  },
  connect: EdgeSocketConnector,
  scheme: 'wss' | 'https' = 'wss'
): Promise<EdgeSpeechResult> {
  const gender: VoiceGender = options.voiceGender === 'male' ? 'male' : 'female';
  const cleanText = options.text.trim();
  if (!cleanText) {
    throw new Error('EMPTY_TTS_TEXT');
  }

  const cacheKey = `${gender}:${cleanText.toLowerCase()}`;
  const cached = getCachedEdgeTts(cacheKey);
  if (cached) {
    return cached;
  }

  const voiceName = EDGE_TTS_VOICES[gender];
  const escaped = escapeXmlForSsml(cleanText);
  if (!escaped) {
    throw new Error('EMPTY_TTS_TEXT');
  }

  const runOnce = async (): Promise<EdgeSpeechResult> => {
    const { url, headers } = buildEdgeTtsConnection(scheme);
    const requestId = randomHex16Bytes().toLowerCase();
    const socket = await connect({ url, headers, timeoutMs: 12000 });

    const decoder = new TextDecoder();
    const audioChunks: Uint8Array[] = [];

    return new Promise<EdgeSpeechResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // Ignore
        }
        reject(new Error('EDGE_TTS_TIMEOUT'));
      }, 15000);

      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore
        }
        if (audioChunks.length === 0) {
          reject(new Error('EDGE_TTS_EMPTY_AUDIO'));
          return;
        }
        const merged = concatUint8Arrays(audioChunks);
        resolve({
          audioBytes: merged,
          mimeType: 'audio/mpeg',
        });
      };

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore
        }
        reject(err);
      };

      socket.onError((err) => finishErr(err));

      socket.onTextMessage((msg) => {
        if (msg.includes('Path:turn.end')) {
          finishOk();
        }
      });

      socket.onBinaryMessage((bytes) => {
        if (bytes.byteLength < 2) return;
        const headerLen = (bytes[0] << 8) | bytes[1];
        const headerEnd = 2 + headerLen;
        if (headerEnd > bytes.byteLength) return;
        const headerText = decoder.decode(bytes.subarray(2, headerEnd));
        if (headerText.includes('Path:audio')) {
          const audioData = bytes.subarray(headerEnd);
          if (audioData.byteLength > 0) {
            audioChunks.push(audioData);
          }
        }
      });

      socket.onClose(() => {
        if (!settled) {
          if (audioChunks.length > 0) {
            finishOk();
          } else {
            finishErr(new Error('EDGE_TTS_CLOSED_EARLY'));
          }
        }
      });

      socket.onOpen(() => {
        const ts = formatEdgeTimestamp();
        const configMessage =
          `X-Timestamp:${ts}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`;

        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${voiceName}'>` +
          `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escaped}</prosody>` +
          `</voice></speak>`;

        const ssmlMessage =
          `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${ts}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml;

        try {
          socket.send(configMessage);
          socket.send(ssmlMessage);
        } catch (err) {
          finishErr(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await runOnce();
      setCachedEdgeTts(cacheKey, result);
      return result;
    } catch (err) {
      lastError = err;
      const errWithDate = err as { statusCode?: number; serverDate?: string };
      if (attempt === 0 && errWithDate?.statusCode === 403 && errWithDate.serverDate) {
        adjustEdgeClockSkewFromDateHeader(errWithDate.serverDate);
        continue;
      }
      if (attempt === 0) {
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('EDGE_TTS_FAILED');
}
