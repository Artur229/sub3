import { DEFAULT_SETTINGS } from '../shared/settings';
import type { WordDetails, WordInsight } from '../shared/types';

type RemoteProvider = 'gemini' | 'groq' | 'deepl' | 'libretranslate';

class ProviderRequestError extends Error {
  constructor(readonly provider: RemoteProvider, readonly status: number, message: string) {
    super(message);
  }
}

type Priority = 'high' | 'low';
type LimitedProvider = 'gemini' | 'groq' | 'deepl';

const MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_COOLDOWN_MS = 20_000;
const providerQueues = new Map<LimitedProvider, { running: number; high: Array<() => void>; low: Array<() => void> }>();
const cooldownUntil = new Map<LimitedProvider, number>();

class RateLimitedError extends ProviderRequestError {}

/** Remembers a 429 so further requests fail fast instead of burning quota until the window resets. */
function noteRateLimit(provider: LimitedProvider, retryAfterMs: number): void {
  const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, 5 * 60_000) : DEFAULT_COOLDOWN_MS;
  cooldownUntil.set(provider, Date.now() + delay);
}

function isCoolingDown(provider: LimitedProvider): boolean {
  return (cooldownUntil.get(provider) ?? 0) > Date.now();
}

async function geminiRetryDelay(response: Response): Promise<number> {
  const payload = await response.clone().json().catch(() => undefined) as { error?: { details?: Array<{ retryDelay?: string }> } } | undefined;
  const delay = payload?.error?.details?.find((detail) => typeof detail.retryDelay === 'string')?.retryDelay ?? '';
  const seconds = Number.parseFloat(delay);
  return Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
}

/**
 * Runs provider requests through a small per-provider queue: at most two in flight,
 * interactive requests ahead of background preloading, and nothing at all while a 429 cooldown is active.
 */
async function limited<T>(provider: LimitedProvider, priority: Priority, task: () => Promise<T>): Promise<T> {
  if (isCoolingDown(provider)) throw new RateLimitedError(provider, 429, providerError(provider, 429).message);
  let queue = providerQueues.get(provider);
  if (!queue) {
    queue = { running: 0, high: [], low: [] };
    providerQueues.set(provider, queue);
  }
  const state = queue;
  if (state.running >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => state[priority].push(resolve));
    if (isCoolingDown(provider)) {
      releaseSlot(state);
      throw new RateLimitedError(provider, 429, providerError(provider, 429).message);
    }
  } else {
    state.running += 1;
  }
  try {
    return await task();
  } finally {
    releaseSlot(state);
  }
}

function releaseSlot(state: { running: number; high: Array<() => void>; low: Array<() => void> }): void {
  const next = state.high.shift() ?? state.low.shift();
  if (next) next();
  else state.running -= 1;
}

let usageWrite = Promise.resolve();

/** Counts real HTTP requests per provider per day, so the popup can show how much quota is being spent. */
function recordUsage(provider: LimitedProvider): void {
  usageWrite = usageWrite.then(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { sub3Usage } = await chrome.storage.local.get('sub3Usage');
    const current = sub3Usage && typeof sub3Usage === 'object' && (sub3Usage as { date?: string }).date === today
      ? sub3Usage as { date: string; counts: Record<string, number> }
      : { date: today, counts: {} };
    current.counts[provider] = (current.counts[provider] ?? 0) + 1;
    await chrome.storage.local.set({ sub3Usage: current });
  }).catch(() => undefined);
}

function geminiThinkingConfig(model: string): Record<string, unknown> {
  const name = model.toLocaleLowerCase();
  // 2.5 Flash/Flash-Lite can switch thinking off entirely; 2.5 Pro cannot.
  if (name.includes('2.5') && name.includes('flash')) return { thinkingConfig: { thinkingBudget: 0 } };
  // Gemini 3+ only accept thinking levels.
  if (/gemini-(?:[3-9]|\d\d)/.test(name)) return { thinkingConfig: { thinkingLevel: 'low' } };
  return {};
}

function groqReasoningConfig(model: string): Record<string, unknown> {
  return model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low', include_reasoning: false } : {};
}

const wordInsightControllers = new Map<string, AbortController>();
const groqJsonModeSupport = new Map<string, boolean>();
let liveTranscriptionTabId: number | undefined;

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture the active tab audio for user-started live subtitle transcription.'
  });
}

async function publishLiveStatus(tabId: number, status: 'starting' | 'recording' | 'idle' | 'error', error?: string): Promise<void> {
  await chrome.storage.session.set({ sub3LiveTranscription: { tabId, status, error: error ?? '' } });
}

function remoteProvider(stored: Record<string, unknown>, override?: unknown): RemoteProvider | 'chrome' {
  const candidate = typeof override === 'string' ? override : stored.translationProvider;
  if (candidate === 'gemini' || candidate === 'groq' || candidate === 'deepl' || candidate === 'libretranslate') return candidate;
  return 'chrome';
}

function providerError(provider: RemoteProvider, status: number): ProviderRequestError {
  const label = provider === 'gemini' ? 'Gemini' : provider === 'groq' ? 'Groq' : provider === 'deepl' ? 'DeepL' : 'LibreTranslate';
  const message = provider === 'deepl' && status === 403
    ? 'DeepL відхилив API key'
    : provider === 'deepl' && status === 456
      ? 'Місячний ліміт DeepL вичерпано'
      : status === 429
        ? `Ліміт ${label} тимчасово вичерпано`
        : `${label} повернув помилку ${status}`;
  return new ProviderRequestError(
    provider,
    status,
    message
  );
}

function deeplLanguage(language: string, target: boolean): string {
  const normalized = language.trim().replace('_', '-').toLocaleLowerCase();
  if (normalized === 'ua' || normalized === 'ukr') return 'UK';
  if (normalized === 'eng') return target ? 'EN-US' : 'EN';
  if (normalized === 'rus') return 'RU';
  if (target && normalized === 'en') return 'EN-US';
  if (target && normalized === 'pt') return 'PT-PT';
  if (target && (normalized === 'zh' || normalized === 'zh-cn')) return 'ZH-HANS';
  return normalized.toLocaleUpperCase();
}

async function requestDeepL(
  texts: string[],
  sourceLanguage: string,
  targetLanguage: string,
  stored: Record<string, unknown>,
  context?: string,
  signal?: AbortSignal
): Promise<string[]> {
  const apiKey = typeof stored.deeplApiKey === 'string' ? stored.deeplApiKey.trim() : '';
  if (!apiKey) throw new Error('Додайте DeepL API key у налаштуваннях Sub3');
  const endpoint = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const source = deeplLanguage(sourceLanguage, false);
  const response = await fetch(`${endpoint}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: texts,
      target_lang: deeplLanguage(targetLanguage, true),
      ...(source && source !== 'AUTO' ? { source_lang: source } : {}),
      preserve_formatting: true,
      ...(context?.trim() ? { context: context.trim().slice(0, 2000) } : {})
    }),
    signal
  });
  recordUsage('deepl');
  if (!response.ok) {
    if (response.status === 429) noteRateLimit('deepl', Number(response.headers.get('retry-after')) * 1000);
    throw providerError('deepl', response.status);
  }
  const data = await response.json() as { translations?: Array<{ text?: string }> };
  const translations = data.translations?.map((item) => item.text?.trim() ?? '') ?? [];
  if (translations.length !== texts.length || translations.some((text) => !text)) {
    throw new Error('DeepL не повернув переклад');
  }
  return translations;
}

async function requestGemini(prompt: string, stored: Record<string, unknown>, signal?: AbortSignal, json = false): Promise<string> {
  const apiKey = typeof stored.geminiApiKey === 'string' ? stored.geminiApiKey.trim() : '';
  const model = typeof stored.geminiModel === 'string' ? stored.geminiModel : DEFAULT_SETTINGS.geminiModel;
  if (!apiKey) throw new Error('Додайте Gemini API key у налаштуваннях Sub3');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        ...(json ? { responseMimeType: 'application/json' } : {}),
        ...geminiThinkingConfig(model)
      }
    }),
    signal
  });
  recordUsage('gemini');
  if (!response.ok) {
    if (response.status === 429) noteRateLimit('gemini', await geminiRetryDelay(response));
    throw providerError('gemini', response.status);
  }
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini не повернув текст');
  return text;
}

async function requestGroq(prompt: string, stored: Record<string, unknown>, signal?: AbortSignal, json = false): Promise<string> {
  const apiKey = typeof stored.groqApiKey === 'string' ? stored.groqApiKey.trim() : '';
  const model = typeof stored.groqModel === 'string' ? stored.groqModel : DEFAULT_SETTINGS.groqModel;
  if (!apiKey) throw new Error('Додайте Groq API key у налаштуваннях Sub3');
  const send = (structured: boolean) => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      messages: [
        { role: 'system', content: 'You are a precise subtitle translator and language-learning assistant. Follow the requested output format exactly.' },
        { role: 'user', content: prompt }
      ],
      ...(structured ? { response_format: { type: 'json_object' } } : {}),
      ...groqReasoningConfig(model)
    }),
    signal
  }).then((response) => { recordUsage('groq'); return response; });
  const structured = json && groqJsonModeSupport.get(model) !== false;
  let response = await send(structured);
  // Some Groq models accept JSON instructions but reject OpenAI JSON mode itself.
  // Retry once without response_format; the prompt still strictly requests JSON.
  if (structured && response.status === 400) {
    groqJsonModeSupport.set(model, false);
    response = await send(false);
  } else if (structured && response.ok) {
    groqJsonModeSupport.set(model, true);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    const detail = payload?.error?.message?.trim();
    if (response.status === 429) {
      noteRateLimit('groq', Number(response.headers.get('retry-after')) * 1000);
      throw providerError('groq', response.status);
    }
    throw new ProviderRequestError('groq', response.status, detail ? `Groq: ${detail}` : `Groq повернув помилку ${response.status}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Groq не повернув текст');
  return text;
}

async function requestProvider(
  provider: 'gemini' | 'groq',
  prompt: string,
  stored: Record<string, unknown>,
  signal?: AbortSignal,
  json = false,
  priority: Priority = 'high'
): Promise<string> {
  try {
    return await limited(provider, priority, () => provider === 'gemini'
      ? requestGemini(prompt, stored, signal, json)
      : requestGroq(prompt, stored, signal, json));
  } catch (error) {
    if (provider === 'gemini'
      && error instanceof ProviderRequestError
      && error.status === 429
      && stored.groqFallbackEnabled === true
      && typeof stored.groqApiKey === 'string'
      && stored.groqApiKey.trim()) {
      return limited('groq', priority, () => requestGroq(prompt, stored, signal, json));
    }
    throw error;
  }
}

async function translateRemotely(
  provider: RemoteProvider,
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  stored: Record<string, unknown>,
  signal?: AbortSignal,
  context = ''
): Promise<string> {
  if (provider === 'deepl') {
    try {
      return (await limited('deepl', 'high', () => requestDeepL([text], sourceLanguage, targetLanguage, stored, context, signal)))[0];
    } catch (error) {
      if (error instanceof ProviderRequestError
        && (error.status === 429 || error.status === 456)
        && stored.groqFallbackEnabled === true
        && typeof stored.groqApiKey === 'string'
        && stored.groqApiKey.trim()) {
        return translateRemotely('groq', text, sourceLanguage, targetLanguage, stored, signal, context);
      }
      throw error;
    }
  }
  if (provider === 'libretranslate') {
    const translationEndpoint = typeof stored.translationEndpoint === 'string' ? stored.translationEndpoint : '';
    if (!translationEndpoint) throw new Error('Не вказано LibreTranslate endpoint');
    const response = await fetch(`${translationEndpoint.replace(/\/$/, '')}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: sourceLanguage, target: targetLanguage, format: 'text' }),
      signal
    });
    if (!response.ok) throw providerError('libretranslate', response.status);
    const data = await response.json() as { translatedText?: string };
    if (!data.translatedText) throw new Error('LibreTranslate не повернув текст');
    return data.translatedText;
  }
  const prompt = [
    `Translate the following ${sourceLanguage} subtitle into ${targetLanguage}.`,
    ...(context ? [`Neighboring subtitle context (use only for disambiguation): ${JSON.stringify(context)}`] : []),
    'Translate the meaning in context, including direction, WH-words, negation, idioms, and sentence fragments that complete the preceding thought.',
    'Return only a concise natural subtitle translation, with no quotes, explanation, or labels.',
    text
  ].join('\n');
  return requestProvider(provider, prompt, stored, signal);
}

async function lookupEnglishWord(word: string, language: string, signal?: AbortSignal): Promise<WordDetails> {
  if (!word || !/^en(?:-|$)/.test(language)) return { synonyms: [], examples: [] };
  const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal });
  if (!response.ok) return { synonyms: [], examples: [] };
  const entries = await response.json() as Array<{
    meanings?: Array<{ synonyms?: string[]; definitions?: Array<{ example?: string; synonyms?: string[] }> }>;
  }>;
  const synonyms = new Set<string>();
  const examples = new Set<string>();
  for (const entry of entries) {
    for (const meaning of entry.meanings ?? []) {
      for (const synonym of meaning.synonyms ?? []) if (synonym && synonym.toLocaleLowerCase() !== word) synonyms.add(synonym);
      for (const definition of meaning.definitions ?? []) {
        for (const synonym of definition.synonyms ?? []) if (synonym && synonym.toLocaleLowerCase() !== word) synonyms.add(synonym);
        if (definition.example) examples.add(definition.example);
      }
    }
  }
  return { synonyms: [...synonyms].slice(0, 5), examples: [...examples].slice(0, 3) };
}

async function lookupEnglishWordFast(word: string, language: string, parentSignal: AbortSignal): Promise<WordDetails> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', relayAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    return await lookupEnglishWord(word, language, controller.signal);
  } catch {
    return { synonyms: [], examples: [] };
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', relayAbort);
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Groq не повернув коректний JSON');
  return JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown>;
}

function containsWord(example: string, word: string): boolean {
  return example.toLocaleLowerCase().split(/[^\p{L}\p{M}'’-]+/u).includes(word.toLocaleLowerCase());
}

async function createWordInsight(
  provider: 'gemini' | 'groq',
  word: string,
  context: string,
  sourceLanguage: string,
  targetLanguage: string,
  stored: Record<string, unknown>,
  signal: AbortSignal,
  surrounding = ''
): Promise<WordInsight> {
  const dictionaryPromise = lookupEnglishWordFast(word.toLocaleLowerCase(), sourceLanguage.toLocaleLowerCase(), signal);
  const prompt = [
    `Create language-learning data for the highlighted ${sourceLanguage} word "${word}" and translate it into ${targetLanguage}.`,
    `Subtitle sentence: ${JSON.stringify(context)}`,
    ...(surrounding && surrounding !== context ? [`Neighbouring subtitle lines (only to understand the meaning): ${JSON.stringify(surrounding)}`] : []),
    'Determine the exact meaning, part of speech, tense, and idiomatic use of the highlighted word in this context before answering.',
    'wordTranslation must be the short, natural equivalent of the highlighted word as it is used in this exact sentence, not its most common dictionary meaning and not a literal calque.',
    'Synonyms and the example sentence must use the same contextual meaning. Do not mix unrelated meanings of the word.',
    'Create one short, natural example sentence.',
    'The example must contain the hovered word exactly as written, as a separate word.',
    'Return only one JSON object with string fields wordTranslation, example, exampleTranslation, contextTranslation and a synonyms array.',
    'Synonyms must be in the source language. contextTranslation must translate the subtitle sentence naturally: check negation, WH-words, direction, tense and pronouns against the source and preserve punctuation.'
  ].join('\n');
  const parsed = parseJsonObject(await requestProvider(provider, prompt, stored, signal, true));
  const dictionary = await dictionaryPromise;
  const dictionaryExample = dictionary.examples.find((example) => containsWord(example, word)) ?? '';
  const draftWordTranslation = typeof parsed.wordTranslation === 'string' ? parsed.wordTranslation.trim() : '';
  const draftExampleTranslation = typeof parsed.exampleTranslation === 'string' ? parsed.exampleTranslation.trim() : '';
  const draftContextTranslation = typeof parsed.contextTranslation === 'string' ? parsed.contextTranslation.trim() : '';
  const reviewed = { wordTranslation: draftWordTranslation, exampleTranslation: draftExampleTranslation, contextTranslation: draftContextTranslation };
  const generatedExample = typeof parsed.example === 'string' && containsWord(parsed.example, word) ? parsed.example.trim() : '';
  const synonyms = Array.isArray(parsed.synonyms)
    ? parsed.synonyms.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  return {
    text: word,
    translatedText: reviewed.wordTranslation || 'Переклад недоступний',
    synonyms: [...new Set([...dictionary.synonyms, ...synonyms])].slice(0, 5),
    example: generatedExample || dictionaryExample || undefined,
    exampleTranslation: reviewed.exampleTranslation || undefined,
    context: context || undefined,
    contextTranslation: reviewed.contextTranslation || undefined,
    provider
  };
}

async function createDeepLWordInsight(
  word: string,
  context: string,
  sourceLanguage: string,
  targetLanguage: string,
  stored: Record<string, unknown>,
  signal: AbortSignal,
  surrounding = ''
): Promise<WordInsight> {
  const dictionaryPromise = lookupEnglishWordFast(word.toLocaleLowerCase(), sourceLanguage.toLocaleLowerCase(), signal);
  const baseTexts = [word, ...(context ? [context] : [])];
  const [dictionary, baseTranslations] = await Promise.all([
    dictionaryPromise,
    limited('deepl', 'high', () => requestDeepL(baseTexts, sourceLanguage, targetLanguage, stored, surrounding || context, signal))
  ]);
  const example = dictionary.examples.find((item) => containsWord(item, word));
  const exampleTranslation = example
    ? (await limited('deepl', 'high', () => requestDeepL([example], sourceLanguage, targetLanguage, stored, example, signal)))[0]
    : undefined;
  const contextTranslation = context ? baseTranslations[1] : undefined;
  return {
    text: word,
    translatedText: baseTranslations[0],
    synonyms: dictionary.synonyms,
    example,
    exampleTranslation,
    context: context || undefined,
    contextTranslation,
    provider: 'deepl'
  };
}

chrome.runtime.onInstalled.addListener(() => {
  // Saving words was removed; drop the old saved list.
  void chrome.storage.local.remove('dictionary');
  void chrome.storage.local.get(null).then((stored) => {
    const legacyLocalDefault = stored.translationProvider === 'libretranslate'
      && (!stored.translationEndpoint || stored.translationEndpoint === 'http://127.0.0.1:5000' || stored.translationEndpoint === 'http://127.0.0.1:5050')
      && !stored.geminiApiKey;
    return chrome.storage.local.set({
      ...DEFAULT_SETTINGS,
      ...stored,
      ...(legacyLocalDefault || !stored.translationProvider ? { translationProvider: 'chrome' } : {}),
      ...(stored.translationEndpoint === 'http://127.0.0.1:5000'
        ? { translationEndpoint: DEFAULT_SETTINGS.translationEndpoint }
        : {})
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_LIVE_TRANSCRIPTION_STATUS') {
    void (async () => {
      const { sub3LiveTranscription } = await chrome.storage.session.get('sub3LiveTranscription');
      const storedStatus = sub3LiveTranscription as { status?: string; tabId?: number; error?: string } | undefined;
      const hasOffscreenDocument = await chrome.offscreen.hasDocument();
      const status = !hasOffscreenDocument && storedStatus?.status !== 'idle'
        ? { status: 'idle' }
        : storedStatus ?? { status: 'idle' };
      if (status.status === 'idle' && storedStatus?.status !== 'idle') {
        await chrome.storage.session.set({ sub3LiveTranscription: status });
      }
      sendResponse({ ok: true, ...status });
    })();
    return true;
  }
  if (message.type === 'START_LIVE_TRANSCRIPTION') {
    void (async () => {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error('Активну вкладку не знайдено');
      const stored = await chrome.storage.local.get(['groqApiKey', 'speechRecognitionLanguage', 'speechRecognitionProvider', 'mlxWhisperEndpoint', 'mlxWhisperModel']);
      if (stored.speechRecognitionProvider !== 'mlx' && (typeof stored.groqApiKey !== 'string' || !stored.groqApiKey.trim())) {
        throw new Error('Додайте Groq API key у вкладці Translation');
      }
      if (liveTranscriptionTabId !== undefined && liveTranscriptionTabId !== tabId) {
        await chrome.runtime.sendMessage({ type: 'SUB3_STOP_TRANSCRIPTION' }).catch(() => undefined);
      }
      liveTranscriptionTabId = tabId;
      await publishLiveStatus(tabId, 'starting');
      await ensureOffscreenDocument();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const result = await chrome.runtime.sendMessage({
        type: 'SUB3_START_TRANSCRIPTION',
        streamId,
        tabId,
        config: {
          groqApiKey: typeof stored.groqApiKey === 'string' ? stored.groqApiKey : '',
          sourceLanguage: typeof stored.speechRecognitionLanguage === 'string' ? stored.speechRecognitionLanguage : DEFAULT_SETTINGS.speechRecognitionLanguage,
          speechRecognitionProvider: stored.speechRecognitionProvider === 'mlx' ? 'mlx' : 'groq',
          mlxWhisperEndpoint: typeof stored.mlxWhisperEndpoint === 'string' ? stored.mlxWhisperEndpoint : DEFAULT_SETTINGS.mlxWhisperEndpoint,
          mlxWhisperModel: typeof stored.mlxWhisperModel === 'string' ? stored.mlxWhisperModel : DEFAULT_SETTINGS.mlxWhisperModel
        }
      }) as { ok?: boolean; error?: string };
      if (!result?.ok) throw new Error(result?.error || 'Не вдалося запустити розпізнавання');
      sendResponse({ ok: true });
    })().catch(async (error: unknown) => {
      const tabId = Number(message.tabId);
      liveTranscriptionTabId = undefined;
      if (Number.isInteger(tabId)) await publishLiveStatus(tabId, 'error', error instanceof Error ? error.message : 'Не вдалося запустити розпізнавання');
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Не вдалося запустити розпізнавання' });
    });
    return true;
  }
  if (message.type === 'STOP_LIVE_TRANSCRIPTION') {
    void chrome.runtime.sendMessage({ type: 'SUB3_STOP_TRANSCRIPTION' })
      .then(() => sendResponse({ ok: true }), (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Не вдалося зупинити розпізнавання' }));
    return true;
  }
  if (message.type === 'SUB3_TRANSCRIPTION_STARTED') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      liveTranscriptionTabId = tabId;
      void publishLiveStatus(tabId, 'recording');
    }
    return undefined;
  }
  if (message.type === 'SUB3_LIVE_TRANSCRIPT') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      void publishLiveStatus(tabId, 'recording');
      void chrome.tabs.sendMessage(tabId, { type: 'SUB3_LIVE_TRANSCRIPT', text: message.text, sourceLanguage: message.sourceLanguage }).catch(() => undefined);
    }
    return undefined;
  }
  if (message.type === 'SUB3_TRANSCRIPTION_ERROR') {
    const tabId = Number(message.tabId);
    if (Number.isInteger(tabId)) {
      void publishLiveStatus(tabId, 'recording', typeof message.error === 'string' ? message.error : 'Розпізнавання недоступне');
      void chrome.tabs.sendMessage(tabId, { type: 'SUB3_LIVE_TRANSCRIPT_ERROR', error: message.error }).catch(() => undefined);
    }
    return undefined;
  }
  if (message.type === 'SUB3_TRANSCRIPTION_STOPPED') {
    const tabId = Number(message.tabId);
    liveTranscriptionTabId = undefined;
    if (Number.isInteger(tabId)) {
      void publishLiveStatus(tabId, 'idle');
      void chrome.tabs.sendMessage(tabId, { type: 'SUB3_LIVE_TRANSCRIPT', text: '' }).catch(() => undefined);
    }
    return undefined;
  }
  if (message.type === 'INSTALL_NETWORK_PROBE') {
    if (!sender.tab?.id) { sendResponse({ ok: false }); return undefined; }
    void chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      func: installNetworkProbe
    }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'FETCH_SUBTITLE') {
    void (async () => {
      const url = new URL(message.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error('Unsupported subtitle URL');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Subtitle file returned ${response.status}`);
      sendResponse({ ok: true, text: await response.text(), contentType: response.headers.get('content-type') ?? '' });
    })().catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Subtitle download failed' }));
    return true;
  }
  if (message.type === 'SUBTITLE_SOURCES') {
    void chrome.storage.session.set({ [`sub3-sources:${sender.tab?.id ?? 'unknown'}:${sender.frameId ?? 0}`]: message.sources });
    return undefined;
  }
  if (message.type === 'LOOKUP_WORD') {
    void (async () => {
      const word = typeof message.word === 'string' ? message.word.trim().toLocaleLowerCase() : '';
      const language = typeof message.language === 'string' ? message.language.toLocaleLowerCase() : '';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        sendResponse({ ok: true, details: await lookupEnglishWord(word, language, controller.signal) });
      } finally {
        clearTimeout(timeout);
      }
    })().catch(() => sendResponse({ ok: true, details: { synonyms: [], examples: [] } }));
    return true;
  }
  if (message.type === 'CANCEL_WORD_INSIGHT') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    wordInsightControllers.get(requestId)?.abort();
    wordInsightControllers.delete(requestId);
    return undefined;
  }
  if (message.type === 'WORD_INSIGHT') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    if (requestId) wordInsightControllers.set(requestId, controller);
    void (async () => {
      const stored = await chrome.storage.local.get(null);
      const provider = remoteProvider(stored);
      if (provider !== 'gemini' && provider !== 'groq' && provider !== 'deepl') {
        sendResponse({ ok: false, local: true });
        return;
      }
      const word = typeof message.word === 'string' ? message.word.trim().slice(0, 80) : '';
      const context = typeof message.context === 'string' ? message.context.trim().slice(0, 800) : '';
      const surrounding = typeof message.surrounding === 'string' ? message.surrounding.trim().slice(0, 1200) : '';
      const sourceLanguage = typeof message.sourceLanguage === 'string' ? message.sourceLanguage : 'en';
      const targetLanguage = typeof message.targetLanguage === 'string' ? message.targetLanguage : 'uk';
      if (!word) throw new Error('Не вказано слово');
      let insight: WordInsight;
      try {
        insight = provider === 'deepl'
          ? await createDeepLWordInsight(word, context, sourceLanguage, targetLanguage, stored, controller.signal, surrounding)
          : await createWordInsight(provider, word, context, sourceLanguage, targetLanguage, stored, controller.signal, surrounding);
      } catch (error) {
        if (provider === 'deepl'
          && error instanceof ProviderRequestError
          && (error.status === 429 || error.status === 456)
          && stored.groqFallbackEnabled === true
          && typeof stored.groqApiKey === 'string'
          && stored.groqApiKey.trim()) {
          insight = await createWordInsight('groq', word, context, sourceLanguage, targetLanguage, stored, controller.signal, surrounding);
        } else {
          throw error;
        }
      }
      sendResponse({ ok: true, insight });
    })().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') {
        sendResponse({ ok: false, error: timedOut ? 'Час очікування перекладу вичерпано' : 'Запит перекладу скасовано' });
        return;
      }
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Не вдалося отримати дані про слово' });
    }).finally(() => {
      clearTimeout(timeout);
      if (requestId) wordInsightControllers.delete(requestId);
    });
    return true;
  }
  if (message.type !== 'TRANSLATE') return undefined;
  void (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const stored = await chrome.storage.local.get(null);
    try {
      const provider = remoteProvider(stored, message.providerOverride);
      if (provider === 'chrome') throw new Error('Вбудований перекладач Chrome недоступний у цій вкладці');
      const translatedText = await translateRemotely(provider, message.text, message.sourceLanguage, message.targetLanguage, stored, controller.signal, typeof message.context === 'string' ? message.context : '');
      sendResponse({ ok: true, result: { text: message.text, translatedText, sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage } });
    } finally {
      clearTimeout(timeout);
    }
  })().catch((error: unknown) => sendResponse({
    ok: false,
    error: error instanceof DOMException && error.name === 'AbortError'
      ? 'Час очікування перекладу вичерпано'
      : error instanceof Error ? error.message : 'Translation failed'
  }));
  return true;
});

/** Runs in the page's MAIN world, so it observes the player's own fetch/XHR calls. */
function installNetworkProbe(): void {
  const key = '__sub3NetworkProbeInstalled';
  const page = window as unknown as Window & { [key: string]: unknown };
  if (page[key]) return;
  page[key] = true;
  const isCandidate = (text: string, url: string) => /(?:\.vtt|\.srt|subtitle|captionTracks|timedtext)/i.test(`${url}\n${text}`);
  const reportYouTubeTracks = () => {
    type PlayerResponse = { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl?: string; languageCode?: string; kind?: string }> } } };
    const youtubeWindow = window as unknown as {
      ytInitialPlayerResponse?: PlayerResponse;
      ytplayer?: { config?: { args?: { player_response?: string } } };
    };
    let response = youtubeWindow.ytInitialPlayerResponse;
    if (!response && youtubeWindow.ytplayer?.config?.args?.player_response) {
      try { response = JSON.parse(youtubeWindow.ytplayer.config.args.player_response) as PlayerResponse; } catch { /* Ignore malformed legacy configuration. */ }
    }
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      ?.filter((track) => track.baseUrl && track.languageCode)
      .map((track) => ({ baseUrl: track.baseUrl, languageCode: track.languageCode, kind: track.kind ?? '' }));
    if (tracks?.length) window.postMessage({ type: 'SUB3_YOUTUBE_TRACKS', tracks }, location.origin);
  };
  reportYouTubeTracks();
  document.addEventListener('yt-navigate-finish', () => {
    window.setTimeout(reportYouTubeTracks, 250);
    window.setTimeout(reportYouTubeTracks, 1200);
  });
  const report = async (response: Response, requestedUrl: string) => {
    try {
      const type = response.headers.get('content-type') ?? '';
      if (!/json|text|javascript/i.test(type) && !/\.vtt|\.srt/i.test(response.url)) return;
      if (Number(response.headers.get('content-length')) > 1_000_000) return;
      const body = await response.clone().text();
      if (body.length > 1_000_000 || !isCandidate(body, response.url || requestedUrl)) return;
      window.postMessage({ type: 'SUB3_PAGE_NETWORK', url: response.url || requestedUrl, body }, location.origin);
    } catch { /* The player may return an opaque or binary response. */ }
  };
  const originalFetch = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const request = args[0];
    const url = typeof request === 'string' ? request : request instanceof Request ? request.url : String(request);
    void report(response, url);
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const url = args[1] instanceof URL ? args[1].href : String(args[1] ?? '');
    this.addEventListener('loadend', () => {
      if (this.responseType && this.responseType !== 'text') return;
      const body = typeof this.responseText === 'string' ? this.responseText : '';
      if (body.length > 1_000_000 || !isCandidate(body, String(url))) return;
      window.postMessage({ type: 'SUB3_PAGE_NETWORK', url: this.responseURL || String(url), body }, location.origin);
    });
    return (originalOpen as (...openArgs: unknown[]) => unknown).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
}
