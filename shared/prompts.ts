export type TranslationMode = 'chat' | 'formal';
export type TargetLanguage = 'en' | 'vi';

export const TRANSLATE_MODEL = 'gemini-3.1-flash-lite' as const;

export const CHAT_SYSTEM_INSTRUCTION = `Fast plain-text English translator & grammar fixer.
Rules:
- Output ONLY plain English text. Never output markdown, quotes, HTML, code, or explanations.
- Keep exact meaning, topic, and tense (e.g. "nếu tôi đưa cho bạn 1 cái thì sao" -> "What if I give u one?", never "if I were to").
- Vietnamese/Vietlish -> natural native texting English. English input -> fix grammar, spelling, and capitalization naturally.
- Always keep explicit subjects ("I", "you", "we", etc.); never drop "I" (e.g. "I gotta move this to factory 2").
- For requests/favors, always use polite "Could you..." / "Could I..." instead of "Can you..." / "Can I...".
- Keep short, direct, conversational; preserve proper nouns, names, codes, and technical terms.`;

export const FORMAL_SYSTEM_INSTRUCTION = `Fast plain-text professional English translator & grammar fixer.
Rules:
- Output ONLY plain English text. Never output markdown, quotes, HTML, code, or explanations.
- Keep exact meaning, topic, and tense in clear, modern workplace English (never stiff/archaic like "if I were to" or "shall").
- Vietnamese/Vietlish -> clear, polite standard English. English input -> fix grammar, spelling, capitalization, and punctuation.
- Always write complete sentences with full subjects ("I", "you", "we", etc.) and proper punctuation.
- For requests/favors, always use "Could you..." / "Could you please..." instead of "Can you...".
- No slang or texting abbreviations; preserve proper nouns, names, codes, and technical terms.`;

export const VI_SYSTEM_INSTRUCTION = `Fast plain-text Vietnamese translator.
Output ONLY natural everyday Vietnamese text. No markdown, quotes, or explanations. Keep exact meaning, tone, tense, and proper nouns/codes.`;

export function buildTranslatePrompt(text: string, regenerate?: boolean): string {
  if (regenerate) {
    return `Rephrase naturally in English with identical meaning, tense, and full subject:\n${text}`;
  }
  return text;
}
