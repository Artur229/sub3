import type { ExtensionSettings } from './types';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  translationProvider: 'chrome',
  sourceLanguage: 'en',
  targetLanguage: 'uk',
  translationEndpoint: 'http://127.0.0.1:5050',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  groqApiKey: '',
  groqModel: 'openai/gpt-oss-20b',
  groqFallbackEnabled: false,
  deeplApiKey: '',
  speechRecognitionProvider: 'groq',
  speechRecognitionLanguage: 'auto',
  mlxWhisperEndpoint: 'http://127.0.0.1:5051',
  mlxWhisperModel: 'mlx-community/whisper-small-mlx',
  preloadSubtitleTrack: true,
  youtubeHumanSubtitles: false,
  originalVisible: true,
  translationVisible: true,
  fontSize: 22,
  textColor: '#ffffff',
  fontWeight: 'bold',
  letterSpacing: 0,
  subtitleBottomPercent: 10,
  subtitleHorizontalPercent: 50,
  subtitleBackgroundOpacity: 0.3,
  subtitleMaxWidthPercent: 86,
  subtitleTextAlign: 'center'
};

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(null);
  return {
    enabled: stored.enabled !== false,
    translationProvider: stored.translationProvider === 'gemini' || stored.translationProvider === 'groq' || stored.translationProvider === 'deepl' || stored.translationProvider === 'libretranslate'
      ? stored.translationProvider
      : 'chrome',
    sourceLanguage: typeof stored.sourceLanguage === 'string' ? stored.sourceLanguage : DEFAULT_SETTINGS.sourceLanguage,
    targetLanguage: typeof stored.targetLanguage === 'string' ? stored.targetLanguage : DEFAULT_SETTINGS.targetLanguage,
    translationEndpoint: typeof stored.translationEndpoint === 'string' ? stored.translationEndpoint : DEFAULT_SETTINGS.translationEndpoint,
    geminiApiKey: typeof stored.geminiApiKey === 'string' ? stored.geminiApiKey : '',
    geminiModel: typeof stored.geminiModel === 'string' ? stored.geminiModel : DEFAULT_SETTINGS.geminiModel,
    groqApiKey: typeof stored.groqApiKey === 'string' ? stored.groqApiKey : '',
    groqModel: typeof stored.groqModel === 'string' ? stored.groqModel : DEFAULT_SETTINGS.groqModel,
    groqFallbackEnabled: stored.groqFallbackEnabled === true,
    deeplApiKey: typeof stored.deeplApiKey === 'string' ? stored.deeplApiKey : '',
    speechRecognitionProvider: stored.speechRecognitionProvider === 'mlx' ? 'mlx' : 'groq',
    speechRecognitionLanguage: typeof stored.speechRecognitionLanguage === 'string' ? stored.speechRecognitionLanguage : DEFAULT_SETTINGS.speechRecognitionLanguage,
    mlxWhisperEndpoint: typeof stored.mlxWhisperEndpoint === 'string' ? stored.mlxWhisperEndpoint : DEFAULT_SETTINGS.mlxWhisperEndpoint,
    mlxWhisperModel: typeof stored.mlxWhisperModel === 'string' ? stored.mlxWhisperModel : DEFAULT_SETTINGS.mlxWhisperModel,
    preloadSubtitleTrack: stored.preloadSubtitleTrack !== false,
    youtubeHumanSubtitles: stored.youtubeHumanSubtitles === true,
    originalVisible: stored.originalVisible !== false,
    translationVisible: stored.translationVisible !== false,
    fontSize: typeof stored.fontSize === 'number' ? stored.fontSize : DEFAULT_SETTINGS.fontSize,
    textColor: typeof stored.textColor === 'string' ? stored.textColor : DEFAULT_SETTINGS.textColor,
    fontWeight: stored.fontWeight === 'normal' ? 'normal' : 'bold',
    letterSpacing: numberInRange(stored.letterSpacing, DEFAULT_SETTINGS.letterSpacing, -1, 5),
    subtitleBottomPercent: numberInRange(stored.subtitleBottomPercent, DEFAULT_SETTINGS.subtitleBottomPercent, 3, 70),
    subtitleHorizontalPercent: numberInRange(stored.subtitleHorizontalPercent, DEFAULT_SETTINGS.subtitleHorizontalPercent, 10, 90),
    subtitleBackgroundOpacity: numberInRange(stored.subtitleBackgroundOpacity, DEFAULT_SETTINGS.subtitleBackgroundOpacity, 0, 0.9),
    subtitleMaxWidthPercent: numberInRange(stored.subtitleMaxWidthPercent, DEFAULT_SETTINGS.subtitleMaxWidthPercent, 50, 96),
    subtitleTextAlign: stored.subtitleTextAlign === 'left' || stored.subtitleTextAlign === 'right'
      ? stored.subtitleTextAlign
      : 'center'
  };
}

export async function updateSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  await chrome.storage.local.set(settings);
}
