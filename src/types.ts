import {
  StudyAnalysis,
  StudyHighlightSegment,
  TranslationMode,
  VoiceGender,
} from '../shared/prompts';
import { EdgeVoiceId, EdgeVoiceOption, SpeechWordTiming } from '../shared/edgeTts';

export type {
  EdgeVoiceId,
  EdgeVoiceOption,
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

export type ChatFontSize = number;

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
