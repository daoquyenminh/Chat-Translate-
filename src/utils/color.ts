import { ChatTheme } from '../types';
import { DEFAULT_THEME } from '../defaults';

export const THEME_STORAGE_KEY = 'cydia_translate_theme_v1';
const THEME_COOKIE_KEY = 'cydia_theme_v1';
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isValidHex(val: unknown): val is string {
  return typeof val === 'string' && HEX_COLOR_RE.test(val.trim());
}

export function normalizeTheme(raw: unknown): ChatTheme {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatTheme>;
  return {
    accentColor: isValidHex(obj.accentColor) ? obj.accentColor.trim() : DEFAULT_THEME.accentColor,
    userBubbleColor: isValidHex(obj.userBubbleColor)
      ? obj.userBubbleColor.trim()
      : DEFAULT_THEME.userBubbleColor,
    botBubbleColor: isValidHex(obj.botBubbleColor)
      ? obj.botBubbleColor.trim()
      : DEFAULT_THEME.botBubbleColor,
    chatBgColor: isValidHex(obj.chatBgColor) ? obj.chatBgColor.trim() : DEFAULT_THEME.chatBgColor,
  };
}

function readThemeCookie(): ChatTheme | null {
  try {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${THEME_COOKIE_KEY}=`));
    if (!match) return null;
    const decoded = decodeURIComponent(match.slice(THEME_COOKIE_KEY.length + 1));
    return normalizeTheme(JSON.parse(decoded));
  } catch {
    return null;
  }
}

export function persistThemeSetting(theme: ChatTheme): void {
  const safe = normalizeTheme(theme);
  const serialized = JSON.stringify(safe);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, serialized);
  } catch {
    // Ignore storage quota errors
  }
  try {
    document.cookie = `${THEME_COOKIE_KEY}=${encodeURIComponent(serialized)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // Ignore cookie errors
  }
}

export function loadSavedTheme(): ChatTheme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      return normalizeTheme(JSON.parse(raw));
    }
  } catch {
    // Fall through to cookie backup
  }
  const fromCookie = readThemeCookie();
  if (fromCookie) {
    persistThemeSetting(fromCookie);
    return fromCookie;
  }
  return DEFAULT_THEME;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);

  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return [17, 17, 17];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function isDarkColor(hex: string): boolean {
  const [r, g, b] = parseHexRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.56;
}

export function getContrastText(hex: string): string {
  return isDarkColor(hex) ? '#FFFFFF' : '#111111';
}

export function applyThemeCssVars(theme: ChatTheme): void {
  const safe = normalizeTheme(theme);
  const root = document.documentElement;
  const chatIsDark = isDarkColor(safe.chatBgColor);
  const botIsDark = isDarkColor(safe.botBubbleColor);
  const accentIsDark = isDarkColor(safe.accentColor);

  root.style.setProperty('--cydia-accent', safe.accentColor);
  root.style.setProperty('--cydia-accent-text', accentIsDark ? '#FFFFFF' : '#111111');
  root.style.setProperty('--cydia-switch-knob', accentIsDark ? '#FFFFFF' : '#111111');

  root.style.setProperty('--cydia-user-bg', safe.userBubbleColor);
  root.style.setProperty('--cydia-user-text', getContrastText(safe.userBubbleColor));

  root.style.setProperty('--cydia-bot-bg', safe.botBubbleColor);
  root.style.setProperty('--cydia-bot-text', getContrastText(safe.botBubbleColor));
  root.style.setProperty(
    '--cydia-bot-border',
    botIsDark ? 'rgba(255, 255, 255, 0.12)' : '#EAEAEA'
  );

  root.style.setProperty('--cydia-chat-bg', safe.chatBgColor);
  root.style.setProperty(
    '--cydia-chat-muted',
    chatIsDark ? '#A1A1AA' : '#8E8E93'
  );
  root.style.setProperty(
    '--cydia-chat-strong',
    chatIsDark ? '#F4F4F5' : '#111111'
  );
}
