export type TranslationMode = 'chat' | 'formal';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  mode?: TranslationMode;
  sourceText?: string;
  isError?: boolean;
}

export interface TranslationLog {
  id: string;
  input: string;
  output: string;
  mode: TranslationMode;
  createdAt: string;
}

export interface ChatTheme {
  accentColor: string;
  userBubbleColor: string;
  botBubbleColor: string;
  chatBgColor: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  theme: ChatTheme;
}
