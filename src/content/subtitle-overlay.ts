import type { ExtensionSettings, SubtitleCue, TranslationResult, WordDetails, WordInsight } from '../shared/types';
import { addDictionaryEntry } from '../dictionary/dictionary-store';
import { cachedTranslation, isQuotaProvider, quickTranslate, translate } from '../translation/translation-manager';

const wordPattern = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu;
const wordInsightCache = new Map<string, WordInsight>();
/** How long text read from the page must stay unchanged before it is translated again. */
const LIVE_TRANSLATION_DELAY_MS = 450;

function wordInsightCacheKey(provider: string, sourceLanguage: string, targetLanguage: string, word: string, context: string): string {
  return [provider, sourceLanguage, targetLanguage, word.toLocaleLowerCase(), context].join('\n');
}

function containsWord(example: string, word: string): boolean {
  return example.toLocaleLowerCase().split(/[^\p{L}\p{M}'’-]+/u).includes(word.toLocaleLowerCase());
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Переклад недоступний';
  if (/gemini.*(?:429|resource)|(?:429|resource).*gemini/i.test(message)) return 'Ліміт Gemini тимчасово вичерпано';
  if (/groq.*429|429.*groq/i.test(message)) return 'Ліміт Groq тимчасово вичерпано';
  return message;
}

export class SubtitleOverlay {
  private readonly root = document.createElement('div');
  private readonly stack = document.createElement('div');
  private readonly original = document.createElement('div');
  private readonly translated = document.createElement('div');
  private readonly card = document.createElement('div');
  private currentCue?: SubtitleCue;
  private externalCues: SubtitleCue[] = [];
  private fallbackCue?: SubtitleCue;
  private translationRevision = 0;
  private wordRevision = 0;
  private hoverTimer?: number;
  private translationTimer?: number;
  private currentWordRequestId?: string;
  private resizeObserver?: ResizeObserver;
  private positionedContainer?: HTMLElement;
  private positionedContainerInlinePosition = '';
  private readonly positionHandler = (): void => this.position();
  private readonly fullscreenHandler = (): void => {
    this.mountForFullscreen();
    this.position();
    requestAnimationFrame(() => this.position());
  };

  constructor(private readonly video: HTMLVideoElement, private settings: ExtensionSettings) {
    this.root.className = 'lingua-subtitle-overlay';
    this.stack.className = 'lingua-subtitle-stack';
    this.original.className = 'lingua-original';
    this.translated.className = 'lingua-translation';
    this.card.className = 'lingua-card';
    this.card.hidden = true;
    this.card.addEventListener('pointerenter', () => this.cancelCardHide());
    this.card.addEventListener('pointerleave', () => this.hideCard());
    this.stack.append(this.card, this.original, this.translated);
    this.root.append(this.stack);
    this.mountForFullscreen();
    this.video.addEventListener('timeupdate', () => this.renderCurrentCue());
    this.video.addEventListener('seeked', () => this.renderCurrentCue());
    this.video.addEventListener('loadedmetadata', () => this.renderCurrentCue());
    this.video.textTracks.addEventListener('addtrack', () => this.renderCurrentCue());
    window.addEventListener('resize', this.positionHandler);
    window.addEventListener('scroll', this.positionHandler, true);
    document.addEventListener('fullscreenchange', this.fullscreenHandler);
    document.addEventListener('webkitfullscreenchange', this.fullscreenHandler);
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(this.positionHandler);
      this.resizeObserver.observe(this.video);
    }
    this.position();
  }

  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.renderCurrentCue();
  }

  setExternalCues(cues: SubtitleCue[]): void {
    this.externalCues = cues;
    this.renderCurrentCue();
  }

  setFallbackCue(cue?: SubtitleCue): void {
    this.fallbackCue = cue;
    this.renderCurrentCue();
  }

  destroy(): void {
    this.cancelWordRequest();
    this.cancelTranslationTimer();
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    window.removeEventListener('resize', this.positionHandler);
    window.removeEventListener('scroll', this.positionHandler, true);
    document.removeEventListener('fullscreenchange', this.fullscreenHandler);
    document.removeEventListener('webkitfullscreenchange', this.fullscreenHandler);
    this.resizeObserver?.disconnect();
    this.root.remove();
    this.restorePositionedContainer();
  }

  private mountForFullscreen(): void {
    const vendorDocument = document as Document & { webkitFullscreenElement?: Element | null };
    const fullscreenElement = document.fullscreenElement ?? vendorDocument.webkitFullscreenElement;
    const videoContainer = this.video.parentElement;
    const mountPoint = fullscreenElement instanceof HTMLElement && fullscreenElement.contains(this.video)
      ? fullscreenElement
      : videoContainer && videoContainer !== document.body && videoContainer !== document.documentElement
        ? videoContainer
        : document.documentElement;
    if (this.root.parentElement === mountPoint) return;
    this.restorePositionedContainer();
    if (mountPoint !== document.documentElement && getComputedStyle(mountPoint).position === 'static') {
      this.positionedContainer = mountPoint;
      this.positionedContainerInlinePosition = mountPoint.style.position;
      mountPoint.style.position = 'relative';
    }
    mountPoint.append(this.root);
  }

  private restorePositionedContainer(): void {
    if (!this.positionedContainer) return;
    this.positionedContainer.style.position = this.positionedContainerInlinePosition;
    this.positionedContainer = undefined;
    this.positionedContainerInlinePosition = '';
  }

  private position(): void {
    this.mountForFullscreen();
    const rect = this.video.getBoundingClientRect();
    const vendorDocument = document as Document & { webkitFullscreenElement?: Element | null };
    const fullscreenElement = document.fullscreenElement ?? vendorDocument.webkitFullscreenElement;
    const isFullscreen = Boolean(fullscreenElement?.contains(this.video));
    const availableScreenWidth = window.screen?.availWidth || window.screen?.width || window.innerWidth;
    const referenceWidth = Math.max(window.innerWidth, availableScreenWidth, 1);
    const playerScale = isFullscreen ? 1 : Math.min(1, Math.max(0.55, rect.width / referenceWidth));
    const effectiveFontSize = Math.max(12, Math.round(this.settings.fontSize * playerScale * 10) / 10);
    const mountPoint = this.root.parentElement;
    if (mountPoint && mountPoint !== document.documentElement) {
      const mountRect = mountPoint.getBoundingClientRect();
      this.root.style.position = 'absolute';
      this.root.style.left = `${rect.left - mountRect.left + mountPoint.scrollLeft}px`;
      this.root.style.top = `${rect.top - mountRect.top + mountPoint.scrollTop}px`;
    } else {
      this.root.style.position = 'fixed';
      this.root.style.left = `${rect.left}px`;
      this.root.style.top = `${rect.top}px`;
    }
    this.root.style.width = `${rect.width}px`;
    this.root.style.height = `${rect.height}px`;
    this.root.style.setProperty('--lingua-color', this.settings.textColor);
    this.root.style.setProperty('--lingua-size', `${effectiveFontSize}px`);
    this.root.style.setProperty('--lingua-weight', this.settings.fontWeight === 'bold' ? '700' : '500');
    this.root.style.setProperty('--lingua-spacing', `${this.settings.letterSpacing}px`);
    this.root.style.setProperty('--lingua-bottom', `${this.settings.subtitleBottomPercent}%`);
    this.root.style.setProperty('--lingua-x', `${this.settings.subtitleHorizontalPercent}%`);
    this.root.style.setProperty('--lingua-shift', this.settings.subtitleHorizontalPercent < 25
      ? '0%'
      : this.settings.subtitleHorizontalPercent > 75
        ? '-100%'
        : '-50%');
    this.root.style.setProperty('--lingua-bg-opacity', String(this.settings.subtitleBackgroundOpacity));
    this.root.style.setProperty('--lingua-max-width', `${this.settings.subtitleMaxWidthPercent}%`);
    this.root.style.setProperty('--lingua-align', this.settings.subtitleTextAlign);
    this.fitCard();
  }

  /**
   * Shows the whole card without inner scrolling: it goes on the side of the subtitles (above or
   * below) that has more room inside the video, switches to a compact layout if it does not fit,
   * and as a last resort is scaled down until it does. Players clip anything outside the video.
   */
  private fitCard(): void {
    if (this.card.hidden) return;
    const gap = 9 + 8;
    const video = this.root.getBoundingClientRect();
    const stack = this.stack.getBoundingClientRect();
    const above = stack.top - Math.max(video.top, 0) - gap;
    const below = Math.min(video.bottom, window.innerHeight) - stack.bottom - gap;
    const placeBelow = below > above;
    this.stack.classList.toggle('lingua-card-below', placeBelow);
    const space = Math.max(60, placeBelow ? below : above);
    this.card.classList.remove('lingua-card-compact');
    this.card.style.removeProperty('--lingua-card-scale');
    if (this.card.scrollHeight > space) this.card.classList.add('lingua-card-compact');
    const height = this.card.scrollHeight;
    if (height > space) this.card.style.setProperty('--lingua-card-scale', (Math.max(0.5, space / height)).toFixed(3));
  }

  private renderCurrentCue(): void {
    this.position();
    const externalCue = this.externalCues.find((item) => item.startTime <= this.video.currentTime && item.endTime >= this.video.currentTime);
    if (this.externalCues.length) {
      if (externalCue) return this.renderCue(externalCue);
      return this.clear();
    }
    if (this.fallbackCue?.originalText) return this.renderCue(this.fallbackCue);
    const track = Array.from(this.video.textTracks).find((item) => item.kind === 'subtitles' || item.kind === 'captions');
    if (!track) return this.clear();
    track.mode = 'hidden';
    if (!track.cues) return this.clear();
    const cue = Array.from(track.cues).find((item) => item.startTime <= this.video.currentTime && item.endTime >= this.video.currentTime);
    if (!cue || !('text' in cue) || typeof cue.text !== 'string') return this.clear();
    this.renderCue({ startTime: cue.startTime, endTime: cue.endTime, originalText: cue.text, sourceLanguage: track.language || this.settings.sourceLanguage });
  }

  private renderCue(current: SubtitleCue): void {
    this.root.dataset.active = 'true';
    this.original.hidden = !this.settings.originalVisible;
    this.translated.hidden = !this.settings.translationVisible;
    const sameCue = this.currentCue?.startTime === current.startTime && this.currentCue.originalText === current.originalText;
    if (sameCue) {
      // A translation track can arrive after the original is already on screen.
      if (current.translatedText && this.currentCue && this.currentCue.translatedText !== current.translatedText) {
        this.currentCue = current;
        if (this.settings.translationVisible) this.setTranslation(current.translatedText);
        return;
      }
      if (this.settings.translationVisible && !this.translated.textContent) {
        this.translated.textContent = 'Переклад…';
        void this.showTranslation(current);
      }
      return;
    }
    this.translationRevision += 1;
    this.wordRevision += 1;
    this.hideCard();
    this.cancelTranslationTimer();
    this.currentCue = current;
    this.original.replaceChildren(...this.words(current.originalText));
    this.translated.removeAttribute('title');
    if (!this.settings.translationVisible) {
      this.translated.textContent = '';
      return;
    }
    // Text read from the page or from live speech grows word by word (YouTube shows captions that way).
    // Keep the previous translation on screen and translate once the text stops changing for a moment,
    // instead of flashing "Переклад…" and re-translating on every word.
    const live = current.endTime === Number.POSITIVE_INFINITY;
    const hasTranslation = Boolean(this.translated.textContent) && this.translated.textContent !== 'Переклад…';
    if (live && hasTranslation) {
      this.translationTimer = window.setTimeout(() => {
        this.translationTimer = undefined;
        void this.showTranslation(current);
      }, LIVE_TRANSLATION_DELAY_MS);
      return;
    }
    this.translated.textContent = 'Переклад…';
    void this.showTranslation(current);
  }

  private cancelTranslationTimer(): void {
    if (this.translationTimer) window.clearTimeout(this.translationTimer);
    this.translationTimer = undefined;
  }

  private clear(): void {
    this.root.dataset.active = 'false';
    this.translationRevision += 1;
    this.cancelTranslationTimer();
    this.currentCue = undefined;
    this.original.replaceChildren();
    this.translated.textContent = '';
    this.hideCard();
  }

  private words(text: string): Node[] {
    const nodes: Node[] = [];
    let offset = 0;
    for (const match of text.matchAll(wordPattern)) {
      const index = match.index ?? 0;
      nodes.push(document.createTextNode(text.slice(offset, index)));
      const button = document.createElement('button');
      button.className = 'lingua-word';
      button.textContent = match[0];
      button.addEventListener('pointerenter', () => this.queueWord(match[0]));
      button.addEventListener('pointerleave', () => this.scheduleCardHide());
      button.addEventListener('click', (event) => { event.stopPropagation(); this.startWord(match[0], true); });
      nodes.push(button);
      offset = index + match[0].length;
    }
    nodes.push(document.createTextNode(text.slice(offset)));
    this.original.onclick = () => { if (this.currentCue) void this.showSentence(this.currentCue); };
    return nodes;
  }

  private async showTranslation(cue: SubtitleCue): Promise<void> {
    const revision = this.translationRevision;
    const sourceLanguage = cue.sourceLanguage ?? this.settings.sourceLanguage;
    const context = cue.contextText ?? cue.originalText;
    const isCurrent = () => revision === this.translationRevision && this.currentCue?.startTime === cue.startTime && this.currentCue.originalText === cue.originalText;
    if (cue.translatedText) {
      // The video's own translation track (YouTube) — nothing to translate.
      this.setTranslation(cue.translatedText);
      return;
    }
    if (isQuotaProvider(this.settings.translationProvider)) {
      // The subtitle line never spends AI quota: Chrome translates it on-device. A line the user
      // already clicked has an AI translation in the cache, and that one is shown instead.
      const cached = await cachedTranslation(cue.originalText, sourceLanguage, this.settings.targetLanguage, context);
      try {
        const result = cached ?? await quickTranslate(cue.originalText, sourceLanguage, this.settings.targetLanguage);
        if (isCurrent()) this.setTranslation(result.translatedText);
      } catch (error) {
        if (!isCurrent()) return;
        this.translated.textContent = 'Клікніть рядок, щоб перекласти';
        this.translated.title = readableError(error);
      }
      return;
    }
    try {
      const result = await translate(cue.originalText, sourceLanguage, this.settings.targetLanguage, context);
      if (isCurrent()) this.setTranslation(result.translatedText);
    } catch (error) {
      if (!isCurrent()) return;
      this.translated.textContent = 'Переклад недоступний';
      this.translated.title = readableError(error);
    }
  }

  private setTranslation(text: string): void {
    this.translated.removeAttribute('title');
    this.translated.textContent = text;
  }

  private queueWord(word: string): void {
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.cancelWordRequest();
    const revision = ++this.wordRevision;
    this.card.hidden = true;
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = undefined;
      void this.loadWord(word, false, revision);
    }, 280);
  }

  private startWord(word: string, expanded: boolean): void {
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = undefined;
    this.cancelWordRequest();
    const revision = ++this.wordRevision;
    void this.loadWord(word, expanded, revision);
  }

  /**
   * Hover shows a free local card (Chrome translator + dictionary). The AI provider is only asked
   * when the user clicks a word, so moving the mouse over subtitles never spends quota.
   */
  private async loadWord(word: string, expanded: boolean, revision: number): Promise<void> {
    const cue = this.currentCue;
    const sourceLanguage = cue?.sourceLanguage ?? this.settings.sourceLanguage;
    const context = cue?.contextText ?? cue?.originalText ?? '';
    const provider = this.settings.translationProvider;
    const remoteKey = wordInsightCacheKey(`remote:${provider}`, sourceLanguage, this.settings.targetLanguage, word, context);
    const localKey = wordInsightCacheKey(`local:${provider}`, sourceLanguage, this.settings.targetLanguage, word, cue?.originalText ?? '');
    const useRemote = expanded && isQuotaProvider(provider);
    let insight = wordInsightCache.get(remoteKey) ?? (useRemote ? undefined : wordInsightCache.get(localKey));
    this.showCard({ text: word, translatedText: useRemote && !insight ? 'Пояснення від ШІ…' : 'Переклад…', synonyms: [] });
    try {
      if (!insight && useRemote) {
        insight = await this.requestRemoteWordInsight(word, context, sourceLanguage);
        if (insight) wordInsightCache.set(remoteKey, insight);
      }
      if (!insight) {
        insight = await this.createLocalWordInsight(word, cue, sourceLanguage);
        wordInsightCache.set(localKey, insight);
      }
      if (revision !== this.wordRevision) return;
      this.showCard(insight);
      if (!expanded && isQuotaProvider(provider) && !wordInsightCache.has(remoteKey)) this.appendHint('Клік — детальне пояснення від ШІ');
      if (expanded) this.appendSaveButton(insight, context, sourceLanguage);
    } catch (error) {
      if (revision !== this.wordRevision) return;
      this.showCard({ text: word, translatedText: readableError(error), synonyms: [], context });
    }
  }

  private async showSentence(cue: SubtitleCue): Promise<void> {
    const revision = ++this.wordRevision;
    this.showCard({ text: cue.originalText, translatedText: 'Переклад…', synonyms: [] });
    try {
      const result = await translate(cue.originalText, cue.sourceLanguage ?? this.settings.sourceLanguage, this.settings.targetLanguage, cue.contextText ?? cue.originalText);
      if (revision === this.wordRevision) this.showCard({ text: result.text, translatedText: result.translatedText, synonyms: [] });
      if (this.currentCue?.startTime === cue.startTime && this.currentCue.originalText === cue.originalText && this.settings.translationVisible) {
        this.setTranslation(result.translatedText);
      }
    } catch (error) {
      if (revision === this.wordRevision) this.showCard({ text: cue.originalText, translatedText: readableError(error), synonyms: [] });
    }
  }

  private requestRemoteWordInsight(word: string, context: string, sourceLanguage: string): Promise<WordInsight | undefined> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.currentWordRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (this.currentWordRequestId === requestId) {
          chrome.runtime.sendMessage({ type: 'CANCEL_WORD_INSIGHT', requestId });
          this.currentWordRequestId = undefined;
        }
        reject(new Error('Час очікування перекладу вичерпано'));
      }, 13500);
      chrome.runtime.sendMessage({
        type: 'WORD_INSIGHT',
        requestId,
        word,
        context,
        sourceLanguage,
        targetLanguage: this.settings.targetLanguage
      }, (response) => {
        window.clearTimeout(timeout);
        if (this.currentWordRequestId === requestId) this.currentWordRequestId = undefined;
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response?.ok && response.insight) resolve(response.insight as WordInsight);
        else if (response?.local) resolve(undefined);
        else reject(new Error(response?.error ?? 'Не вдалося отримати дані про слово'));
      });
    });
  }

  private async createLocalWordInsight(word: string, cue: SubtitleCue | undefined, sourceLanguage: string): Promise<WordInsight> {
    const target = this.settings.targetLanguage;
    const quota = isQuotaProvider(this.settings.translationProvider);
    const sentence = cue?.originalText ?? '';
    const [wordTranslation, lookup, sentenceTranslation] = await Promise.allSettled([
      // A single short word is cheap and cached; it is the one thing worth a provider request if Chrome cannot help.
      quickTranslate(word, sourceLanguage, target).catch(() => translate(word, sourceLanguage, target)),
      this.lookupWord(word, sourceLanguage),
      // Reuse the subtitle line's own translation (normally already cached) instead of translating a new context.
      cue ? this.sentenceTranslation(cue, sourceLanguage, quota) : Promise.resolve(undefined)
    ]);
    const details = lookup.status === 'fulfilled' ? lookup.value : { synonyms: [], examples: [] };
    const example = details.examples.find((candidate) => containsWord(candidate, word));
    let exampleTranslation: string | undefined;
    if (example) {
      try {
        exampleTranslation = (await (quota ? quickTranslate(example, sourceLanguage, target) : translate(example, sourceLanguage, target))).translatedText;
      } catch { /* The original example remains useful if its translation fails. */ }
    }
    return {
      text: word,
      translatedText: wordTranslation.status === 'fulfilled' ? wordTranslation.value.translatedText : readableError(wordTranslation.reason),
      synonyms: details.synonyms,
      example,
      exampleTranslation,
      context: sentence || undefined,
      contextTranslation: sentenceTranslation.status === 'fulfilled' ? sentenceTranslation.value : undefined,
      provider: this.settings.translationProvider
    };
  }

  private async sentenceTranslation(cue: SubtitleCue, sourceLanguage: string, quota: boolean): Promise<string | undefined> {
    const context = cue.contextText ?? cue.originalText;
    if (cue.translatedText) return cue.translatedText;
    if (!quota) return (await translate(cue.originalText, sourceLanguage, this.settings.targetLanguage, context)).translatedText;
    const cached = await cachedTranslation(cue.originalText, sourceLanguage, this.settings.targetLanguage, context);
    return cached?.translatedText ?? (await quickTranslate(cue.originalText, sourceLanguage, this.settings.targetLanguage)).translatedText;
  }

  private appendHint(text: string): void {
    const hint = document.createElement('small');
    hint.className = 'lingua-hint';
    hint.textContent = text;
    this.card.append(hint);
    this.fitCard();
  }

  private lookupWord(word: string, language: string): Promise<WordDetails> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'LOOKUP_WORD', word, language }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) resolve({ synonyms: [], examples: [] });
        else resolve(response.details as WordDetails);
      });
    });
  }

  private appendSaveButton(insight: WordInsight, context: string, sourceLanguage: string): void {
    const result: TranslationResult = {
      text: insight.text,
      translatedText: insight.translatedText,
      sourceLanguage,
      targetLanguage: this.settings.targetLanguage
    };
    const save = document.createElement('button');
    save.className = 'lingua-save';
    save.textContent = 'Зберегти слово';
    save.onclick = () => void addDictionaryEntry(result, context);
    this.card.append(save);
    this.fitCard();
  }

  private showCard(insight: WordInsight): void {
    this.cancelCardHide();
    this.card.hidden = false;
    this.card.replaceChildren();
    const original = document.createElement('strong');
    original.textContent = insight.text;
    const value = document.createElement('span');
    value.className = 'lingua-card-translation';
    value.textContent = insight.translatedText;
    value.classList.toggle('lingua-error', /(?:недоступ|ліміт|помил|час очікування|скасовано)/i.test(insight.translatedText));
    this.card.append(original, value);
    if (insight.synonyms.length) {
      const label = document.createElement('small');
      label.textContent = 'Синоніми';
      const synonyms = document.createElement('div');
      synonyms.className = 'lingua-synonyms';
      for (const synonym of insight.synonyms) {
        const chip = document.createElement('span');
        chip.textContent = synonym;
        synonyms.append(chip);
      }
      this.card.append(label, synonyms);
    }
    if (insight.example) {
      const label = document.createElement('small');
      label.textContent = 'Приклад зі словом';
      const example = document.createElement('div');
      example.className = 'lingua-example';
      const source = document.createElement('p');
      source.className = 'lingua-card-source';
      source.textContent = insight.example;
      example.append(source);
      if (insight.exampleTranslation) {
        const target = document.createElement('p');
        target.className = 'lingua-card-target';
        target.textContent = insight.exampleTranslation;
        example.append(target);
      }
      this.card.append(label, example);
    }
    // The current subtitle line and its translation are already on screen; repeating them only makes the card taller.
    if (insight.context && insight.context.trim() !== this.currentCue?.originalText.trim()) {
      const label = document.createElement('small');
      label.textContent = 'Контекст із субтитрів';
      const context = document.createElement('div');
      context.className = 'lingua-context';
      const source = document.createElement('p');
      source.className = 'lingua-card-source';
      source.textContent = insight.context;
      context.append(source);
      if (insight.contextTranslation) {
        const target = document.createElement('p');
        target.className = 'lingua-card-target';
        target.textContent = insight.contextTranslation;
        context.append(target);
      }
      this.card.append(label, context);
    }
    this.fitCard();
  }

  private hideTimer?: number;
  private scheduleCardHide(): void {
    this.cancelCardHide();
    this.hideTimer = window.setTimeout(() => this.hideCard(), 140);
  }
  private cancelCardHide(): void { if (this.hideTimer) window.clearTimeout(this.hideTimer); }
  private cancelWordRequest(): void {
    if (!this.currentWordRequestId) return;
    chrome.runtime.sendMessage({ type: 'CANCEL_WORD_INSIGHT', requestId: this.currentWordRequestId });
    this.currentWordRequestId = undefined;
  }
  private hideCard(): void {
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = undefined;
    this.cancelWordRequest();
    this.wordRevision += 1;
    this.card.hidden = true;
  }
}
