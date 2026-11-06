export interface SubtitleCue {
  startTime: number;
  endTime: number;
  originalText: string;
  translatedText?: string;
  contextText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export interface DetectedTextTrack {
  id: string;
  kind: TextTrackKind;
  label: string;
  language: string;
  cues: SubtitleCue[];
}

export interface DetectedVideo {
  id: string;
  tracks: DetectedTextTrack[];
}

export interface ExtensionSettings {
  enabled: boolean;
  translationProvider: 'chrome' | 'libretranslate' | 'deepl' | 'gemini' | 'groq';
  sourceLanguage: string;
  targetLanguage: string;
  translationEndpoint: string;
  geminiApiKey: string;
  geminiModel: string;
  groqApiKey: string;
  groqModel: string;
  groqFallbackEnabled: boolean;
  deeplApiKey: string;
  speechRecognitionProvider: 'groq' | 'mlx';
  speechRecognitionLanguage: string;
  mlxWhisperEndpoint: string;
  mlxWhisperModel: string;
  preloadSubtitleTrack: boolean;
  youtubeHumanSubtitles: boolean;
  originalVisible: boolean;
  translationVisible: boolean;
  fontSize: number;
  textColor: string;
  fontWeight: 'normal' | 'bold';
  letterSpacing: number;
  subtitleBottomPercent: number;
  subtitleHorizontalPercent: number;
  subtitleBackgroundOpacity: number;
  subtitleMaxWidthPercent: number;
  subtitleTextAlign: 'left' | 'center' | 'right';
}

export interface TranslationResult {
  text: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface WordDetails {
  synonyms: string[];
  examples: string[];
}

export interface WordInsight {
  text: string;
  translatedText: string;
  synonyms: string[];
  example?: string;
  exampleTranslation?: string;
  context?: string;
  contextTranslation?: string;
  provider?: 'chrome' | 'libretranslate' | 'deepl' | 'gemini' | 'groq';
}

export interface DictionaryEntry extends TranslationResult {
  id: string;
  context: string;
  addedAt: string;
}
