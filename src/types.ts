import {
  StudyAnalysis,
  StudyHighlightSegment,
  TranslationMode,
  VoiceGender,
} from '../shared/prompts';

export type { StudyAnalysis, StudyHighlightSegment, TranslationMode, VoiceGender };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  mode?: TranslationMode;
  sourceText?: string;
  isError?: boolean;
  viTranslation?: string;
  showViTranslation?: boolean;
  viError?: string;
  studyData?: StudyAnalysis;
}

export interface SavedLesson {
  id: string;
  sourceText: string;
  translatedText: string;
  mode: TranslationMode;
  data: StudyAnalysis;
  savedAt: string;
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
