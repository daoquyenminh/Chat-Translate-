import { SpeechWordTiming } from '../types';

export interface AlignedWordRange {
  start: number;
  end: number;
  startMs: number;
  endMs: number;
}

function normalizeChar(ch: string): string {
  if (ch === '\u2019' || ch === '\u2018' || ch === '`') return "'";
  if (ch === '\u201C' || ch === '\u201D') return '"';
  if (ch === '\u2013' || ch === '\u2014') return '-';
  return ch.toLowerCase();
}

function normalizeStr(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += normalizeChar(str[i]);
  }
  return out;
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  return !/[a-z0-9]/i.test(ch);
}

/**
 * Maps Edge TTS WordBoundary timings onto exact [start, end) character ranges
 * in the original display text while preserving punctuation, casing, and newlines.
 */
export function alignTimingsToText(
  originalText: string,
  timings: SpeechWordTiming[]
): AlignedWordRange[] {
  if (!originalText || timings.length === 0) return [];

  const normSource = normalizeStr(originalText);
  const ranges: AlignedWordRange[] = [];
  let cursor = 0;

  for (const item of timings) {
    const rawWord = item.text.trim();
    if (!rawWord) continue;
    const normWord = normalizeStr(rawWord);

    const searchLimit = Math.min(normSource.length, cursor + 80);
    const windowStr = normSource.slice(cursor, searchLimit);

    let foundOffset = -1;
    let searchFrom = 0;

    // Prefer a match aligned on a word boundary to avoid matching inside another word
    while (searchFrom < windowStr.length) {
      const idx = windowStr.indexOf(normWord, searchFrom);
      if (idx === -1) break;
      const absStart = cursor + idx;
      const absEnd = absStart + normWord.length;
      const leftOk = isWordBoundaryChar(normSource[absStart - 1]);
      const rightOk = isWordBoundaryChar(normSource[absEnd]);
      if (leftOk && rightOk) {
        foundOffset = idx;
        break;
      }
      if (foundOffset === -1) {
        foundOffset = idx;
      }
      searchFrom = idx + 1;
    }

    if (foundOffset !== -1) {
      const start = cursor + foundOffset;
      const end = start + normWord.length;
      ranges.push({
        start,
        end,
        startMs: item.startMs,
        endMs: item.endMs,
      });
      cursor = end;
      continue;
    }

    // Fallback: if TTS split/expanded a symbol or number token (e.g. "B2", "100%", "$5"),
    // bind it to the next non-whitespace token without skipping far ahead.
    let probe = cursor;
    while (probe < originalText.length && /\s/.test(originalText[probe])) {
      probe++;
    }
    if (probe < originalText.length && probe - cursor <= 8) {
      let tokenEnd = probe;
      while (tokenEnd < originalText.length && !/\s/.test(originalText[tokenEnd])) {
        tokenEnd++;
      }
      // Strip trailing punctuation for a crisp highlight
      while (tokenEnd > probe + 1 && /[.,!?;:)"'\]]/.test(originalText[tokenEnd - 1])) {
        tokenEnd--;
      }
      if (/[0-9$%@#&/+\-]/.test(originalText.slice(probe, tokenEnd))) {
        ranges.push({
          start: probe,
          end: tokenEnd,
          startMs: item.startMs,
          endMs: item.endMs,
        });
      }
    }
  }

  return ranges;
}

/**
 * Finds the active word range for a given audio playback timestamp (ms).
 * Bridges tiny inter-word gaps (<= 90ms) so the highlight glides smoothly without flicker.
 */
export function findActiveWordRange(
  ranges: AlignedWordRange[],
  currentMs: number
): AlignedWordRange | null {
  if (ranges.length === 0) return null;

  let low = 0;
  let high = ranges.length - 1;
  let candidateIdx = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid].startMs <= currentMs) {
      candidateIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidateIdx === -1) return null;

  const current = ranges[candidateIdx];
  const next = ranges[candidateIdx + 1];

  if (currentMs <= current.endMs + 90) {
    return current;
  }

  // If the pause before the next word is very short, keep holding until next starts
  if (next && next.startMs - current.endMs <= 160 && currentMs < next.startMs) {
    return current;
  }

  return null;
}
