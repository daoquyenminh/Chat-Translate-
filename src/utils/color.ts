import { ChatTheme } from '../types';

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
  const root = document.documentElement;
  const chatIsDark = isDarkColor(theme.chatBgColor);
  const botIsDark = isDarkColor(theme.botBubbleColor);
  const accentIsDark = isDarkColor(theme.accentColor);

  root.style.setProperty('--cydia-accent', theme.accentColor);
  root.style.setProperty('--cydia-accent-text', accentIsDark ? '#FFFFFF' : '#111111');
  root.style.setProperty('--cydia-switch-knob', accentIsDark ? '#FFFFFF' : '#111111');

  root.style.setProperty('--cydia-user-bg', theme.userBubbleColor);
  root.style.setProperty('--cydia-user-text', getContrastText(theme.userBubbleColor));

  root.style.setProperty('--cydia-bot-bg', theme.botBubbleColor);
  root.style.setProperty('--cydia-bot-text', getContrastText(theme.botBubbleColor));
  root.style.setProperty(
    '--cydia-bot-border',
    botIsDark ? 'rgba(255, 255, 255, 0.12)' : '#EAEAEA'
  );

  root.style.setProperty('--cydia-chat-bg', theme.chatBgColor);
  root.style.setProperty(
    '--cydia-chat-muted',
    chatIsDark ? '#A1A1AA' : '#8E8E93'
  );
  root.style.setProperty(
    '--cydia-chat-strong',
    chatIsDark ? '#F4F4F5' : '#111111'
  );
}
