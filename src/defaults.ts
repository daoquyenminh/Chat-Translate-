import { ChatMessage, ChatTheme, ThemePreset } from './types';

export const INITIAL_MESSAGES: ChatMessage[] = [];

export const DEFAULT_THEME: ChatTheme = {
  accentColor: '#DA0B0B',
  userBubbleColor: '#111111',
  botBubbleColor: '#31B47B',
  chatBgColor: '#FAFAFA',
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'minimal',
    name: 'Tối giản',
    theme: {
      accentColor: '#111111',
      userBubbleColor: '#111111',
      botBubbleColor: '#FFFFFF',
      chatBgColor: '#FAFAFA',
    },
  },
  {
    id: 'ocean',
    name: 'Xanh dương',
    theme: {
      accentColor: '#2563EB',
      userBubbleColor: '#2563EB',
      botBubbleColor: '#FFFFFF',
      chatBgColor: '#F5F8FF',
    },
  },
  {
    id: 'emerald',
    name: 'Xanh lá',
    theme: {
      accentColor: '#059669',
      userBubbleColor: '#059669',
      botBubbleColor: '#FFFFFF',
      chatBgColor: '#F4FAF7',
    },
  },
  {
    id: 'plum',
    name: 'Tím trầm',
    theme: {
      accentColor: '#6D28D9',
      userBubbleColor: '#6D28D9',
      botBubbleColor: '#FFFFFF',
      chatBgColor: '#F9F7FD',
    },
  },
  {
    id: 'terracotta',
    name: 'Cam ấm',
    theme: {
      accentColor: '#EA580C',
      userBubbleColor: '#EA580C',
      botBubbleColor: '#FFFFFF',
      chatBgColor: '#FDF8F5',
    },
  },
  {
    id: 'dark',
    name: 'Tối',
    theme: {
      accentColor: '#F4F4F5',
      userBubbleColor: '#27272A',
      botBubbleColor: '#18181B',
      chatBgColor: '#09090B',
    },
  },
];
