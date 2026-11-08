import { VideoDetector } from './video-detector';
import { getSettings } from '../shared/settings';
import { SubtitleOverlay } from './subtitle-overlay';
import type { ExtensionSettings, SubtitleCue } from '../shared/types';
import { attachTranslations, extractRemoteSubtitles, parseTimedSubtitles, type RemoteSubtitle } from './external-subtitles';
import { findSubtitleDomSource, readSubtitleDomText, type SubtitleDomSource } from './dom-subtitles';
import { extractTikTokTracks, isTikTok, tiktokVideoId, type TikTokTrack } from './tiktok-subtitles';
import { preloadTranslations } from '../translation/translation-manager';
import './overlay.css';

let detector: VideoDetector | undefined;
const overlays = new Map<HTMLVideoElement, SubtitleOverlay>();
let settings: ExtensionSettings;
const subtitleCache = new Map<string, SubtitleCue[]>();
const translationTrackCache = new Map<string, SubtitleCue[]>();
// TikTok: subtitle tracks per video id, built cues per video id and languages, and what each <video> shows.
const tiktokTracks = new Map<string, TikTokTrack[]>();
const tiktokCues = new Map<string, Promise<SubtitleCue[] | undefined>>();
const tiktokVideoCues = new WeakMap<HTMLVideoElement, SubtitleCue[]>();
let latestSources: RemoteSubtitle[] = [];
let currentExternalCues: SubtitleCue[] = [];
let currentFallbackCue: SubtitleCue | undefined;
let currentLiveCue: SubtitleCue | undefined;
const liveTranscriptHistory: string[] = [];
let activeSubtitleSourceUrl = '';
const preloadedTracks = new Set<string>();
let networkProbeRequested = false;

/** The fetch/XHR probe is only installed once a page actually shows a video, not on every site. */
function ensureNetworkProbe(): void {
  if (networkProbeRequested) return;
  networkProbeRequested = true;
  void chrome.runtime.sendMessage({ type: 'INSTALL_NETWORK_PROBE' }).catch(() => { networkProbeRequested = false; });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'SUB3_PAGE_NETWORK') void consumeNetworkPayload(event.data);
  if (event.data?.type === 'SUB3_YOUTUBE_TRACKS') void consumeYouTubeTracks(event.data.tracks);
});

async function consumeYouTubeTracks(value: unknown): Promise<void> {
  if (!Array.isArray(value)) return;
  const sources: RemoteSubtitle[] = value.flatMap((item): RemoteSubtitle[] => {
    if (!item || typeof item !== 'object') return [];
    const track = item as { baseUrl?: unknown; languageCode?: unknown; kind?: unknown };
    if (typeof track.baseUrl !== 'string' || typeof track.languageCode !== 'string') return [];
    try {
      const url = new URL(track.baseUrl);
      url.searchParams.set('fmt', 'vtt');
      return [{ language: track.languageCode, url: url.href, kind: typeof track.kind === 'string' ? track.kind : '', youtube: true }];
    } catch {
      return [];
    }
  });
  if (!sources.length) return;
  latestSources = sources;
  const selected = selectSource(sources);
  if (selected) await loadSubtitle(selected);
}

async function consumeNetworkPayload(payload: { body?: string; url?: string }): Promise<void> {
  const raw = payload.body ?? '';
  if (isTikTok()) {
    try { rememberTikTokTracks(JSON.parse(raw)); } catch { /* Not a JSON feed response. */ }
    return;
  }
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* Some players return a labelled URL string, not JSON. */ }
  const sources = extractRemoteSubtitles(value);
  if (!sources.length) return;
  latestSources = sources;
  chrome.runtime.sendMessage({ type: 'SUBTITLE_SOURCES', sources, pageUrl: location.href });
  const selected = selectSource(sources);
  if (selected) {
    await loadSubtitle(selected);
  } else {
    clearExternalSubtitles();
  }
}

async function fetchCues(url: string, language: string): Promise<SubtitleCue[]> {
  const response = await chrome.runtime.sendMessage({ type: 'FETCH_SUBTITLE', url, pageUrl: location.href }).catch(() => undefined) as { ok?: boolean; text?: string } | undefined;
  if (!response?.ok || !response.text) return [];
  return parseTimedSubtitles(response.text, language);
}

async function loadSubtitle(source: RemoteSubtitle): Promise<void> {
  let cues = subtitleCache.get(source.url);
  if (!cues) {
    cues = addNeighborContexts(await fetchCues(source.url, languageCode(source.language)));
    if (cues.length) subtitleCache.set(source.url, cues);
  }
  if (!cues.length) return;
  activeSubtitleSourceUrl = source.url;
  showExternalCues(cues);
  // Show the original at once; the translation track (if YouTube has one) is attached when it arrives.
  const translated = await loadYouTubeTranslation(source, cues);
  if (activeSubtitleSourceUrl !== source.url) return;
  if (translated) showExternalCues(translated);
  const untranslated = (translated ?? cues).filter((cue) => !cue.translatedText);
  scheduleTrackPreload(untranslated, source.url);
}

function showExternalCues(cues: SubtitleCue[]): void {
  currentExternalCues = cues;
  currentFallbackCue = undefined;
  document.documentElement.classList.add('sub3-external-subtitles');
  overlays.forEach((overlay) => {
    overlay.setFallbackCue(undefined);
    overlay.setExternalCues(cues);
  });
}

/**
 * The translation line on YouTube comes from YouTube itself when possible: a human-made track in the
 * target language (if the user allows it), otherwise YouTube's own auto-translation of the original
 * track, which keeps the original timings. Chrome translates only what is still missing.
 */
function youtubeTranslationUrl(source: RemoteSubtitle): string | undefined {
  if (!source.youtube) return undefined;
  const target = languageCode(settings.targetLanguage);
  if (!target || target === languageCode(source.language)) return undefined;
  if (settings.youtubeHumanSubtitles) {
    const human = latestSources.find((item) => item.youtube && item.kind !== 'asr' && languageCode(item.language) === target);
    if (human) return human.url;
  }
  const url = new URL(source.url);
  url.searchParams.set('tlang', target);
  return url.href;
}

async function loadYouTubeTranslation(source: RemoteSubtitle, cues: SubtitleCue[]): Promise<SubtitleCue[] | undefined> {
  const url = youtubeTranslationUrl(source);
  if (!url) return undefined;
  let lines = translationTrackCache.get(url);
  if (!lines) {
    lines = await fetchCues(url, languageCode(settings.targetLanguage));
    if (!lines.length) return undefined;
    translationTrackCache.set(url, lines);
  }
  return attachTranslations(cues, lines);
}

function addNeighborContexts(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue, index) => ({
    ...cue,
    contextText: cues.slice(Math.max(0, index - 1), Math.min(cues.length, index + 2))
      .map((item) => item.originalText)
      .join(' ')
  }));
}

/** Translates the whole track in the background. With Gemini, Groq or DeepL selected this goes through Chrome, not the provider. */
function scheduleTrackPreload(cues: SubtitleCue[], sourceUrl: string): void {
  if (!settings.preloadSubtitleTrack || !settings.translationVisible || !cues.length) return;
  const sourceLanguage = cues[0].sourceLanguage || settings.sourceLanguage;
  const key = [settings.translationProvider, sourceLanguage, settings.targetLanguage, sourceUrl].join('|');
  if (preloadedTracks.has(key)) return;
  preloadedTracks.add(key);
  const run = () => {
    void preloadTranslations(cues.map((cue) => ({ text: cue.originalText, context: cue.contextText })), sourceLanguage, settings.targetLanguage)
      .catch(() => preloadedTracks.delete(key));
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 1200 });
  else globalThis.setTimeout(run, 350);
}

function rememberTikTokTracks(value: unknown): void {
  const found = extractTikTokTracks(value);
  if (!found.size) return;
  found.forEach((tracks, id) => tiktokTracks.set(id, tracks));
  refreshTikTokVideos();
}

function readTikTokPageData(): void {
  const text = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent;
  if (!text) return;
  try { rememberTikTokTracks(JSON.parse(text)); } catch { /* The page changed its embedded data format. */ }
}

/**
 * The TikTok feed keeps several <video> elements on the page at once, so each overlay gets the
 * subtitles of its own video instead of one track for the whole page.
 */
function refreshTikTokVideos(): void {
  if (!isTikTok()) return;
  overlays.forEach((overlay, video) => void showTikTokSubtitles(video, overlay));
}

async function showTikTokSubtitles(video: HTMLVideoElement, overlay: SubtitleOverlay): Promise<void> {
  const id = tiktokVideoId(video);
  const tracks = id ? tiktokTracks.get(id) : undefined;
  if (!id || !tracks) {
    if (tiktokVideoCues.has(video)) {
      tiktokVideoCues.delete(video);
      overlay.setExternalCues([]);
    }
    return;
  }
  const key = [id, languageCode(settings.sourceLanguage), languageCode(settings.targetLanguage)].join('|');
  let loading = tiktokCues.get(key);
  if (!loading) {
    loading = buildTikTokCues(tracks);
    tiktokCues.set(key, loading);
    void loading.then((cues) => { if (!cues) tiktokCues.delete(key); });
  }
  const cues = await loading;
  if (!cues || tiktokVideoCues.get(video) === cues || overlays.get(video) !== overlay) return;
  tiktokVideoCues.set(video, cues);
  document.documentElement.classList.add('sub3-external-subtitles');
  overlay.setExternalCues(cues);
  scheduleTrackPreload(cues.filter((cue) => !cue.translatedText), `tiktok:${id}`);
}

/** Original: the video's own captions in the subtitle language. Translation: TikTok's machine translation into the target language, if it has one. */
async function buildTikTokCues(tracks: TikTokTrack[]): Promise<SubtitleCue[] | undefined> {
  const desired = languageCode(settings.sourceLanguage);
  const own = tracks.filter((track) => track.kind !== 'mt');
  const source = (desired === 'auto' ? own : own.filter((track) => languageCode(track.language) === desired))[0];
  if (!source) return undefined;
  const original = addNeighborContexts(await fetchCues(source.url, languageCode(source.language)));
  if (!original.length) return undefined;
  const target = languageCode(settings.targetLanguage);
  const translation = languageCode(source.language) === target
    ? undefined
    : tracks.find((track) => track !== source && languageCode(track.language) === target);
  const lines = translation ? await fetchCues(translation.url, target) : [];
  return lines.length ? attachTranslations(original, lines) : original;
}

function selectSource(sources: RemoteSubtitle[]): RemoteSubtitle | undefined {
  const desired = languageCode(settings.sourceLanguage);
  const matching = desired === 'auto' ? sources : sources.filter((source) => languageCode(source.language) === desired);
  // Prefer human-made captions to YouTube's auto-generated ('asr') ones.
  return matching.find((source) => source.kind !== 'asr') ?? matching[0];
}

function clearExternalSubtitles(): void {
  currentExternalCues = [];
  activeSubtitleSourceUrl = '';
  document.documentElement.classList.remove('sub3-external-subtitles');
  overlays.forEach((overlay) => overlay.setExternalCues([]));
}

function languageCode(language: string): string {
  const value = language.trim().toLocaleLowerCase();
  if (/^(en|eng|english)$/.test(value)) return 'en';
  if (/^(uk|ua|ukr|українська|украинский|українські)$/.test(value)) return 'uk';
  if (/^(ru|rus|русский|русские)$/.test(value)) return 'ru';
  // TikTok uses three-letter codes (deu-DE, spa-ES); map the common ones to the two-letter codes in settings.
  const threeLetter: Record<string, string> = { deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', pol: 'pl', ita: 'it', por: 'pt', jpn: 'ja', kor: 'ko', cmn: 'zh', zho: 'zh', chi: 'zh', tur: 'tr', ara: 'ar', hin: 'hi', ind: 'id', vie: 'vi', tha: 'th', nld: 'nl', dut: 'nl' };
  if (threeLetter[value]) return threeLetter[value];
  // YouTube uses regional codes such as en-GB or es-419; match them by the base language.
  if (/^[a-z]{2,3}-[a-z0-9]+$/.test(value)) return languageCode(value.split('-')[0]);
  return value || settings.sourceLanguage;
}

async function scanInlinePlayerConfiguration(): Promise<void> {
  for (const script of document.scripts) {
    const text = script.textContent ?? '';
    for (const match of text.matchAll(/"subtitle"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
      try {
        const subtitle = JSON.parse(`"${match[1]}"`) as string;
        await consumeNetworkPayload({ body: subtitle, url: location.href });
      } catch { /* Ignore unrelated or malformed inline configuration. */ }
    }
  }
}

function installSubtitleTextFallback(): void {
  let observedSource: SubtitleDomSource | undefined;
  let observer: MutationObserver | undefined;
  const publish = () => {
    if (currentLiveCue) return;
    if (currentExternalCues.length) {
      currentFallbackCue = undefined;
      overlays.forEach((overlay) => overlay.setFallbackCue(undefined));
      return;
    }
    const source = observedSource?.container.isConnected ? observedSource : findSubtitleDomSource();
    const text = source ? readSubtitleDomText(source) : '';
    if (!text) {
      currentFallbackCue = undefined;
      overlays.forEach((overlay) => overlay.setFallbackCue(undefined));
      return;
    }
    const playerLanguage = source?.player === 'playerjs'
      ? document.querySelector('#cdnplayer_control_cc_icon0')?.getAttribute('data-content') || settings.sourceLanguage
      : settings.sourceLanguage;
    currentFallbackCue = { startTime: 0, endTime: Number.POSITIVE_INFINITY, originalText: text, sourceLanguage: languageCode(playerLanguage) };
    document.documentElement.classList.add('sub3-external-subtitles');
    overlays.forEach((overlay) => overlay.setFallbackCue(currentFallbackCue));
  };
  const attach = () => {
    const source = findSubtitleDomSource();
    if (!source) {
      const hadObservedParent = Boolean(observedSource);
      observer?.disconnect();
      observer = undefined;
      observedSource = undefined;
      if (hadObservedParent) publish();
      return;
    }
    if (source.container === observedSource?.container) return;
    observer?.disconnect();
    observedSource = source;
    observer = new MutationObserver(publish);
    observer.observe(source.container, { childList: true, characterData: true, subtree: true });
    publish();
  };
  new MutationObserver(() => attach()).observe(document.documentElement, { childList: true, subtree: true });
  attach();
  document.addEventListener('yt-navigate-finish', () => {
    clearExternalSubtitles();
    currentFallbackCue = undefined;
    overlays.forEach((overlay) => overlay.setFallbackCue(undefined));
    attach();
  });
}

/** Muted hover previews on YouTube's home page and search results play in their own small player, not the watched video. */
function isYouTubePreview(video: HTMLVideoElement): boolean {
  return /(^|\.)youtube\.com$/.test(location.hostname) && Boolean(video.closest('#inline-preview-player, #inline-player, ytd-video-preview'));
}

async function sync(enabled: boolean): Promise<void> {
  if (enabled && !detector) {
    detector = new VideoDetector((videos) => {
      window.dispatchEvent(new CustomEvent('lingua:videos-detected', { detail: videos }));
      const visibleVideos = Array.from(document.querySelectorAll<HTMLVideoElement>('video')).filter((video) => {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        return rect.width >= 200 && rect.height >= 100 && style.display !== 'none' && style.visibility !== 'hidden' && !isYouTubePreview(video);
      });
      if (videos.length) ensureNetworkProbe();
      refreshTikTokVideos();
      const visibleSet = new Set(visibleVideos);
      overlays.forEach((overlay, video) => {
        if (!visibleSet.has(video)) {
          overlay.destroy();
          overlays.delete(video);
        }
      });
      visibleVideos.forEach((video) => {
        if (!overlays.has(video)) {
          const overlay = new SubtitleOverlay(video, settings);
          overlays.set(video, overlay);
          if (currentExternalCues.length) overlay.setExternalCues(currentExternalCues);
          if (isTikTok()) void showTikTokSubtitles(video, overlay);
          if (currentLiveCue ?? currentFallbackCue) overlay.setFallbackCue(currentLiveCue ?? currentFallbackCue);
        }
      });
    });
    detector.start();
  }
  if (!enabled && detector) {
    detector.stop();
    detector = undefined;
    overlays.forEach((overlay) => overlay.destroy());
    overlays.clear();
    document.documentElement.classList.remove('sub3-external-subtitles');
  }
}

void getSettings().then(async (loaded) => {
  settings = loaded;
  installSubtitleTextFallback();
  await sync(settings.enabled);
  await scanInlinePlayerConfiguration();
  if (isTikTok()) {
    readTikTokPageData();
    ensureNetworkProbe();
  }
  if (/(^|\.)youtube\.com$/.test(location.hostname) || document.querySelector('video')) ensureNetworkProbe();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SUB3_LIVE_TRANSCRIPT') {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (text && liveTranscriptHistory.at(-1) !== text) {
      liveTranscriptHistory.push(text);
      if (liveTranscriptHistory.length > 3) liveTranscriptHistory.shift();
    }
    const contextText = liveTranscriptHistory.join(' ');
    currentLiveCue = text
      ? { startTime: 0, endTime: Number.POSITIVE_INFINITY, originalText: text, contextText, sourceLanguage: typeof message.sourceLanguage === 'string' && message.sourceLanguage ? message.sourceLanguage : settings.speechRecognitionLanguage }
      : undefined;
    if (currentLiveCue && settings.translationVisible) {
      void preloadTranslations([{ text, context: contextText }], currentLiveCue.sourceLanguage ?? settings.sourceLanguage, settings.targetLanguage);
    }
    document.documentElement.classList.toggle('sub3-external-subtitles', Boolean(currentLiveCue || currentExternalCues.length || currentFallbackCue));
    overlays.forEach((overlay) => overlay.setFallbackCue(currentLiveCue ?? currentFallbackCue));
    return undefined;
  }
  if (message?.type !== 'SUB3_SETTINGS_UPDATED') return undefined;
  void getSettings().then((loaded) => {
    settings = loaded;
    void sync(settings.enabled);
    if (latestSources.length) {
      const selected = selectSource(latestSources);
      if (selected) void loadSubtitle(selected);
      else clearExternalSubtitles();
    }
    if (settings.preloadSubtitleTrack && currentExternalCues.length) {
      scheduleTrackPreload(currentExternalCues, activeSubtitleSourceUrl || location.href);
    }
    overlays.forEach((overlay) => overlay.updateSettings(settings));
    refreshTikTokVideos();
  });
  return undefined;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // The background writes the daily request counter here; it is not a setting.
    if (Object.keys(changes).every((key) => key === 'sub3Usage')) return;
    void getSettings().then((loaded) => {
      settings = loaded;
      if (changes.enabled) void sync(settings.enabled);
      if ((changes.sourceLanguage || changes.targetLanguage || changes.youtubeHumanSubtitles) && latestSources.length) {
        const selected = selectSource(latestSources);
        if (selected) void loadSubtitle(selected);
        else clearExternalSubtitles();
      }
      if (changes.sourceLanguage || changes.targetLanguage) refreshTikTokVideos();
      if ((changes.preloadSubtitleTrack || changes.targetLanguage || changes.translationProvider) && settings.preloadSubtitleTrack && currentExternalCues.length) {
        scheduleTrackPreload(currentExternalCues, activeSubtitleSourceUrl || location.href);
      }
      overlays.forEach((overlay) => overlay.updateSettings(settings));
    });
  }
});
