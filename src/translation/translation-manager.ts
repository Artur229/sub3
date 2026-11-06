import type { ExtensionSettings, TranslationResult } from '../shared/types';
import { getSettings } from '../shared/settings';
import { TranslationCache } from './cache';

const cache = new TranslationCache();
const inFlight = new Map<string, Promise<TranslationResult>>();
const browserTranslators = new Map<string, Promise<BrowserTranslator>>();

interface BrowserTranslator {
  translate(text: string): Promise<string>;
}

interface BrowserTranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator>;
}

/** Providers with per-request quotas (AI and DeepL). They are only called on an explicit click, never for the subtitle line itself. */
export function isQuotaProvider(provider: ExtensionSettings['translationProvider']): boolean {
  return provider === 'gemini' || provider === 'groq' || provider === 'deepl';
}

function normalizedLanguage(language: string): string {
  const normalized = language.trim().toLocaleLowerCase();
  if (normalized === 'ua' || normalized === 'ukr') return 'uk';
  if (normalized === 'eng') return 'en';
  if (normalized === 'rus') return 'ru';
  return normalized.split('-')[0];
}

function cacheNamespace(settings: ExtensionSettings): string {
  return settings.translationProvider === 'gemini'
    ? `gemini:${settings.geminiModel}`
    : settings.translationProvider === 'groq'
      ? `groq:${settings.groqModel}`
      : settings.translationProvider === 'deepl'
        ? 'deepl:v2'
        : settings.translationProvider;
}

async function translateInChrome(text: string, sourceLanguage: string, targetLanguage: string): Promise<TranslationResult> {
  const source = normalizedLanguage(sourceLanguage);
  const target = normalizedLanguage(targetLanguage);
  if (!source || source === 'auto') throw new Error('Оберіть мову оригіналу у вкладці General');
  if (source === target) return { text, translatedText: text, sourceLanguage: source, targetLanguage: target };

  const factory = (globalThis as typeof globalThis & { Translator?: BrowserTranslatorFactory }).Translator;
  if (!factory) throw new Error('Оновіть Chrome: вбудований перекладач недоступний у цій версії');
  const pair = `${source}:${target}`;
  let translator = browserTranslators.get(pair);
  if (!translator) {
    translator = (async () => {
      const availability = await factory.availability({ sourceLanguage: source, targetLanguage: target });
      if (availability === 'unavailable') throw new Error(`Chrome не підтримує переклад ${source} → ${target}`);
      return factory.create({ sourceLanguage: source, targetLanguage: target });
    })();
    browserTranslators.set(pair, translator);
    translator.catch(() => browserTranslators.delete(pair));
  }
  const translatedText = (await (await translator).translate(text)).trim();
  if (!translatedText) throw new Error('Вбудований перекладач Chrome не повернув текст');
  return { text, translatedText, sourceLanguage: source, targetLanguage: target };
}

function translateViaBackground(text: string, sourceLanguage: string, targetLanguage: string, context = '', providerOverride?: 'groq'): Promise<TranslationResult> {
  return new Promise<TranslationResult>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Час очікування перекладу вичерпано'));
    }, 13500);
    chrome.runtime.sendMessage({ type: 'TRANSLATE', text, context, sourceLanguage, targetLanguage, providerOverride }, (response) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error ?? 'Переклад недоступний'));
      } else {
        resolve(response.result as TranslationResult);
      }
    });
  });
}

export async function preloadTranslations(items: Array<string | { text: string; context?: string }>, sourceLanguage: string, targetLanguage: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.preloadSubtitleTrack || !settings.translationVisible) return;
  if (isQuotaProvider(settings.translationProvider)) {
    // The subtitle line for quota providers comes from Chrome, so the track is preloaded with Chrome (free, no limits).
    const texts = [...new Set(items.map((item) => (typeof item === 'string' ? item : item.text).trim()).filter(Boolean))];
    let next = 0;
    const chromeWorker = async (): Promise<void> => {
      while (next < texts.length) {
        const text = texts[next++];
        try { await quickTranslate(text, sourceLanguage, targetLanguage); } catch { /* The line is translated again when it is shown. */ }
      }
    };
    await Promise.all([chromeWorker(), chromeWorker()]);
    return;
  }
  const namespace = cacheNamespace(settings);
  const unique = new Map<string, { text: string; context: string }>();
  for (const item of items) {
    const text = (typeof item === 'string' ? item : item.text).trim();
    const context = (typeof item === 'string' ? '' : item.context ?? '').trim();
    if (text) unique.set(`${text}\n${context}`, { text, context });
  }
  const missing: Array<{ text: string; context: string }> = [];
  for (const item of unique.values()) {
    const cached = await cache.get(item.text, sourceLanguage, targetLanguage, namespace, item.context).catch(() => undefined);
    if (!cached) missing.push(item);
  }
  if (!missing.length) return;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < missing.length) {
      const item = missing[cursor++];
      try { await translate(item.text, sourceLanguage, targetLanguage, item.context); } catch { /* Playback can still translate this cue on demand. */ }
    }
  };
  await Promise.all([worker(), worker()]);
}

/** Returns a cached translation from the selected provider without sending any request. */
export async function cachedTranslation(text: string, sourceLanguage: string, targetLanguage: string, context = ''): Promise<TranslationResult | undefined> {
  const settings = await getSettings();
  return cache.get(text.trim(), sourceLanguage, targetLanguage, cacheNamespace(settings), context.trim()).catch(() => undefined);
}

/** Instant, free, on-device translation. Used for the subtitle line when the selected provider has quotas. */
export async function quickTranslate(text: string, sourceLanguage: string, targetLanguage: string): Promise<TranslationResult> {
  const normalized = text.trim();
  const cached = await cache.get(normalized, sourceLanguage, targetLanguage, 'chrome').catch(() => undefined);
  if (cached) return cached;
  const result = await translateInChrome(normalized, sourceLanguage, targetLanguage);
  await cache.put(result, 'chrome').catch(() => undefined);
  return result;
}

export async function translate(text: string, sourceLanguage: string, targetLanguage: string, context = ''): Promise<TranslationResult> {
  const normalized = text.trim();
  if (!normalized) throw new Error('Nothing to translate');
  const settings = await getSettings();
  const namespace = cacheNamespace(settings);
  const normalizedContext = context.trim();
  const cached = await cache.get(normalized, sourceLanguage, targetLanguage, namespace, normalizedContext).catch(() => undefined);
  if (cached) return cached;

  const requestKey = `${settings.translationProvider}:${sourceLanguage}:${targetLanguage}:${normalized}:${normalizedContext}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing;

  const primaryRequest = settings.translationProvider === 'chrome'
    ? translateInChrome(normalized, sourceLanguage, targetLanguage).catch((error: unknown) => {
      if (settings.groqFallbackEnabled && settings.groqApiKey?.trim()) {
        return translateViaBackground(normalized, sourceLanguage, targetLanguage, normalizedContext, 'groq');
      }
      throw error;
    })
    : translateViaBackground(normalized, sourceLanguage, targetLanguage, normalizedContext);

  const request = primaryRequest.then(async (result) => {
    await cache.put(result, namespace, normalizedContext).catch(() => undefined);
    return result;
  }).finally(() => inFlight.delete(requestKey));

  inFlight.set(requestKey, request);
  return request;
}
