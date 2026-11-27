import {
  MODEL_OPTIONS,
  ModelOption,
  TranslateModelId,
  TranslationMode,
} from '../shared/prompts';

export { MODEL_OPTIONS };
export type { ModelOption, TranslateModelId, TranslationMode };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  mode?: TranslationMode;
  model?: TranslateModelId;
  sourceText?: string;
  isError?: boolean;
  viTranslation?: string;
  showViTranslation?: boolean;
  viError?: string;
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
