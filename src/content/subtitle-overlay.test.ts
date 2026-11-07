import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionSettings } from '../shared/types';

vi.mock('../translation/translation-manager', () => ({
  isQuotaProvider: (provider: string) => provider === 'gemini' || provider === 'groq' || provider === 'deepl',
  cachedTranslation: vi.fn(async () => undefined),
  preloadTranslations: vi.fn(async () => undefined),
  quickTranslate: vi.fn(async (text: string, sourceLanguage: string, targetLanguage: string) => ({
    text,
    translatedText: `chrome:${text}`,
    sourceLanguage,
    targetLanguage
  })),
  translate: vi.fn(async (text: string, sourceLanguage: string, targetLanguage: string) => ({
    text,
    translatedText: `uk:${text}`,
    sourceLanguage,
    targetLanguage
  }))
}));

import { SubtitleOverlay } from './subtitle-overlay';
import { translate } from '../translation/translation-manager';

const settings: ExtensionSettings = {
  enabled: true,
  translationProvider: 'gemini',
  sourceLanguage: 'en',
  targetLanguage: 'uk',
  translationEndpoint: '',
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
  textColor: '#fff',
  fontWeight: 'bold',
  letterSpacing: 0,
  subtitleBottomPercent: 10,
  subtitleHorizontalPercent: 50,
  subtitleBackgroundOpacity: 0.3,
  subtitleMaxWidthPercent: 86,
  subtitleTextAlign: 'center'
};

describe('SubtitleOverlay fallback', () => {
  beforeEach(() => {
    document.querySelectorAll('.lingua-subtitle-overlay, video').forEach((node) => node.remove());
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: undefined,
        sendMessage: vi.fn((message: { type?: string }, callback?: (response: unknown) => void) => {
          if (message.type === 'WORD_INSIGHT') {
            callback?.({
              ok: true,
              insight: {
                text: 'strategy',
                translatedText: 'стратегія',
                synonyms: ['approach', 'plan'],
                example: 'That strategy worked well.',
                exampleTranslation: 'Ця стратегія добре спрацювала.',
                context: 'A useful strategy.',
                contextTranslation: 'Корисна стратегія.',
                provider: 'groq'
              }
            });
          } else if (message.type === 'LOOKUP_WORD') {
            callback?.({ ok: true, details: { synonyms: ['approach', 'plan'], examples: ['That strategy worked well.'] } });
          } else {
            callback?.({ ok: true });
          }
        })
      }
    });
  });

  it('renders a replacement Playerjs cue and preserves setting changes', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 3908, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 10, y: 20, top: 20, left: 10, right: 650, bottom: 380, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);

    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'Why?', sourceLanguage: 'en' });
    expect(document.querySelector('.lingua-original')?.textContent).toBe('Why?');

    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'Because.', sourceLanguage: 'en' });
    expect(document.querySelector('.lingua-original')?.textContent).toBe('Because.');

    overlay.updateSettings({ ...settings, originalVisible: false });
    expect((document.querySelector('.lingua-original') as HTMLElement).hidden).toBe(true);
    overlay.destroy();
  });

  it('treats a loaded VTT track as authoritative during cue gaps', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 5, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);

    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'Боевики Детективы', sourceLanguage: 'ru' });
    overlay.setExternalCues([{ startTime: 10, endTime: 12, originalText: 'Real subtitle', sourceLanguage: 'en' }]);

    expect(document.querySelector('.lingua-original')?.textContent).toBe('');
    expect((document.querySelector('.lingua-subtitle-overlay') as HTMLElement).dataset.active).toBe('false');
    overlay.destroy();
  });

  it('applies subtitle position and appearance settings immediately', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);
    overlay.updateSettings({ ...settings, subtitleBottomPercent: 42, subtitleHorizontalPercent: 20, subtitleBackgroundOpacity: 0.5, subtitleMaxWidthPercent: 70, subtitleTextAlign: 'left' });
    const root = document.querySelector('.lingua-subtitle-overlay') as HTMLElement;

    expect(root.style.getPropertyValue('--lingua-bottom')).toBe('42%');
    expect(root.style.getPropertyValue('--lingua-x')).toBe('20%');
    expect(root.style.getPropertyValue('--lingua-bg-opacity')).toBe('0.5');
    expect(root.style.getPropertyValue('--lingua-max-width')).toBe('70%');
    expect(root.style.getPropertyValue('--lingua-align')).toBe('left');
    overlay.destroy();
  });

  it('shows translation, synonyms, and examples outside the subtitle rows', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);
    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'A useful strategy.', sourceLanguage: 'en' });

    document.querySelector<HTMLElement>('.lingua-word:last-of-type')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.lingua-card')?.textContent).toContain('That strategy worked well.'));
    expect(document.querySelector('.lingua-save')).toBeNull();

    const stack = document.querySelector('.lingua-subtitle-stack') as HTMLElement;
    const card = document.querySelector('.lingua-card') as HTMLElement;
    expect(card.parentElement).toBe(stack);
    expect(card.textContent).toContain('Синоніми');
    expect(card.textContent).toContain('approach');
    expect(card.textContent).toContain('Приклад зі словом');
    expect(card.textContent).toContain('Ця стратегія добре спрацювала.');
    expect(card.textContent).toContain('Переклад фрази');
    expect(card.textContent).toContain('Корисна стратегія.');
    expect(getComputedStyle(card).position).not.toBe('absolute');

    // With the subtitles moved near the top of the video, there is more room below them.
    const rect = (top: number, bottom: number) => () => ({ x: 0, y: top, top, left: 0, right: 640, bottom, width: 640, height: bottom - top, toJSON: () => ({}) });
    (document.querySelector('.lingua-subtitle-overlay') as HTMLElement).getBoundingClientRect = rect(0, 360);
    stack.getBoundingClientRect = rect(40, 120);
    overlay.updateSettings({ ...settings, subtitleBottomPercent: 70 });
    expect(stack.classList.contains('lingua-card-below')).toBe(true);
    overlay.destroy();
  });

  it('shows a free local card on hover without asking the AI provider', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);
    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'A clever tactic.', sourceLanguage: 'en' });

    document.querySelector<HTMLElement>('.lingua-word:last-of-type')?.dispatchEvent(new Event('pointerenter'));
    await vi.waitFor(() => expect(document.querySelector('.lingua-card')?.textContent).toContain('chrome:tactic'));
    const card = document.querySelector('.lingua-card') as HTMLElement;
    expect(card.textContent).toContain('approach');
    expect(card.textContent).toContain('Клік — детальне пояснення від ШІ');
    const sent = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => (message as { type?: string }).type);
    expect(sent).not.toContain('WORD_INSIGHT');
    overlay.destroy();
  });

  it('translates the subtitle line with Chrome only, and clicking the line asks nothing', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    vi.mocked(translate).mockClear();
    const overlay = new SubtitleOverlay(video, settings);
    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'Things change.', sourceLanguage: 'en' });

    const line = document.querySelector('.lingua-translation') as HTMLElement;
    await vi.waitFor(() => expect(line.textContent).toBe('chrome:Things change.'));
    expect(translate).not.toHaveBeenCalled();

    (document.querySelector('.lingua-original') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(line.textContent).toBe('chrome:Things change.');
    expect(translate).not.toHaveBeenCalled();
    expect((document.querySelector('.lingua-card') as HTMLElement).hidden).toBe(true);
    overlay.destroy();
  });

  it('shows the whole word card inside the video without inner scrolling', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 100, top: 100, left: 0, right: 640, bottom: 460, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);
    overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'Son...', sourceLanguage: 'en' });
    const rect = (top: number, bottom: number) => () => ({ x: 0, y: top, top, left: 0, right: 640, bottom, width: 640, height: bottom - top, toJSON: () => ({}) });
    (document.querySelector('.lingua-subtitle-overlay') as HTMLElement).getBoundingClientRect = rect(100, 460);
    (document.querySelector('.lingua-subtitle-stack') as HTMLElement).getBoundingClientRect = rect(330, 420);

    const card = document.querySelector('.lingua-card') as HTMLElement;
    Object.defineProperty(card, 'scrollHeight', { configurable: true, get: () => 426 });

    document.querySelector<HTMLElement>('.lingua-word')?.dispatchEvent(new Event('pointerenter'));
    await vi.waitFor(() => expect(card.textContent).toContain('chrome:Son'));
    // 330 (subtitles top) - 100 (video top) - 17 (gap) = 213px; a 426px card is shown whole at half size.
    expect(card.classList.contains('lingua-card-compact')).toBe(true);
    expect(card.style.getPropertyValue('--lingua-card-scale')).toBe('0.500');
    expect(card.style.maxHeight).toBe('');
    expect(document.querySelector('.lingua-subtitle-stack')?.classList.contains('lingua-card-below')).toBe(false);
    overlay.destroy();
  });

  it('keeps the translation on screen while page captions grow word by word', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const video = document.createElement('video');
      Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
      Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
      video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
      document.body.append(video);
      const overlay = new SubtitleOverlay(video, settings);
      const line = () => (document.querySelector('.lingua-translation') as HTMLElement).textContent;
      overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'group', sourceLanguage: 'en' });
      await vi.waitFor(() => expect(line()).toBe('chrome:group'));

      overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'group anagrams', sourceLanguage: 'en' });
      overlay.setFallbackCue({ startTime: 0, endTime: Infinity, originalText: 'group anagrams so', sourceLanguage: 'en' });
      expect(line()).toBe('chrome:group');

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(line()).toBe('chrome:group anagrams so'));
      overlay.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a translation that came with the video instead of translating', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);
    const cue = { startTime: 0, endTime: 5, originalText: 'Hello there.', sourceLanguage: 'en' };
    overlay.setExternalCues([cue]);
    const line = document.querySelector('.lingua-translation') as HTMLElement;
    await vi.waitFor(() => expect(line.textContent).toBe('chrome:Hello there.'));

    overlay.setExternalCues([{ ...cue, translatedText: 'Привіт.' }]);
    expect(line.textContent).toBe('Привіт.');
    overlay.destroy();
  });

  it('does not touch a zero-height video wrapper (TikTok) and mounts in the positioned player instead', () => {
    const player = document.createElement('div');
    player.style.position = 'relative';
    const wrapper = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 1, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 348, bottom: 618, width: 348, height: 618, toJSON: () => ({}) });
    wrapper.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 348, bottom: 0, width: 348, height: 0, toJSON: () => ({}) });
    wrapper.append(video);
    player.append(wrapper);
    document.body.append(player);
    const overlay = new SubtitleOverlay(video, settings);
    expect(document.querySelector('.lingua-subtitle-overlay')?.parentElement).toBe(player);
    expect(wrapper.style.position).toBe('');
    overlay.destroy();
    player.remove();
  });

  it('marks the overlay inactive with empty lines when no subtitle is on screen', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 10, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) });
    document.body.append(video);
    const overlay = new SubtitleOverlay(video, settings);
    overlay.setExternalCues([{ startTime: 0, endTime: 5, originalText: 'Earlier line.', sourceLanguage: 'en' }]);
    const root = document.querySelector('.lingua-subtitle-overlay') as HTMLElement;
    expect(root.dataset.active).toBe('false');
    expect((document.querySelector('.lingua-original') as HTMLElement).textContent).toBe('');
    expect((document.querySelector('.lingua-translation') as HTMLElement).textContent).toBe('');
    overlay.destroy();
  });

  it('moves the overlay into the fullscreen player and keeps appearance values', () => {
    const player = document.createElement('div');
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
    Object.defineProperty(video, 'textTracks', { value: Object.assign([], { addEventListener: vi.fn() }) });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) });
    player.append(video);
    document.body.append(player);
    const overlay = new SubtitleOverlay(video, settings);
    overlay.updateSettings({ ...settings, fontSize: 31, subtitleBottomPercent: 24 });

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: player });
    document.dispatchEvent(new Event('fullscreenchange'));
    const root = document.querySelector('.lingua-subtitle-overlay') as HTMLElement;

    expect(root.parentElement).toBe(player);
    expect(root.style.position).toBe('absolute');
    expect(root.style.getPropertyValue('--lingua-size')).toBe('31px');
    expect(root.style.getPropertyValue('--lingua-bottom')).toBe('24%');

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(root.parentElement).toBe(player);
    overlay.destroy();
    player.remove();
  });
});
