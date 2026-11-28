import {
  StudyAnalysis,
  StudyHighlightSegment,
  TranslationMode,
  VoiceGender,
} from '../shared/prompts';
import { SpeechWordTiming } from '../shared/edgeTts';

export type {
  SpeechWordTiming,
  StudyAnalysis,
  StudyHighlightSegment,
  TranslationMode,
  VoiceGender,
};

export interface SpeechHighlightRange {
  key: string;
  start: number;
  end: number;
}

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
