/**
 * TikTok sends subtitle files together with each video's data, in two places:
 * - `video.subtitleInfos`: [{ LanguageCodeName: 'eng-US', Url, Format: 'webvtt', Source: 'ASR' | 'MT' }]
 * - `video.claInfo.captionInfos`: [{ languageCode: 'eng-US', url, urlList, isAutoGen, ... }]
 * The data comes from the page's embedded JSON (first videos) and from the feed API
 * (`/api/recommend/item_list/` and similar) while scrolling.
 */

export interface TikTokTrack {
  /** Language as TikTok writes it, e.g. 'eng-US'. */
  language: string;
  url: string;
  /** 'mt' for TikTok's machine translation, 'asr' for auto captions, '' otherwise. */
  kind: 'mt' | 'asr' | '';
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isVtt(format: unknown): boolean {
  return typeof format !== 'string' || !format || /vtt/i.test(format);
}

function tracksOf(video: Json): TikTokTrack[] {
  const tracks: TikTokTrack[] = [];
  const seen = new Set<string>();
  const add = (track: TikTokTrack) => {
    const key = `${track.language}|${track.kind}`;
    if (!track.url || seen.has(key)) return;
    seen.add(key);
    tracks.push(track);
  };
  for (const info of Array.isArray(video.subtitleInfos) ? video.subtitleInfos : []) {
    if (!isObject(info) || !isVtt(info.Format)) continue;
    const language = typeof info.LanguageCodeName === 'string' ? info.LanguageCodeName : '';
    const url = typeof info.Url === 'string' ? info.Url : '';
    const source = typeof info.Source === 'string' ? info.Source.toUpperCase() : '';
    if (language) add({ language, url, kind: source === 'MT' ? 'mt' : source === 'ASR' ? 'asr' : '' });
  }
  const cla = isObject(video.claInfo) ? video.claInfo : undefined;
  for (const info of Array.isArray(cla?.captionInfos) ? cla.captionInfos : []) {
    if (!isObject(info) || !isVtt(info.captionFormat ?? info.format)) continue;
    const language = typeof info.languageCode === 'string' ? info.languageCode : typeof info.language === 'string' ? info.language : '';
    const urlList = Array.isArray(info.urlList) ? info.urlList.filter((item): item is string => typeof item === 'string') : [];
    const url = typeof info.url === 'string' && info.url ? info.url : urlList[0] ?? '';
    if (language) add({ language, url, kind: info.isAutoGen === true ? 'asr' : '' });
  }
  return tracks;
}

/** Collects subtitle tracks for every TikTok video found anywhere in a JSON value, keyed by video id. */
export function extractTikTokTracks(value: unknown): Map<string, TikTokTrack[]> {
  const found = new Map<string, TikTokTrack[]>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 12 || !item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    const record = item as Json;
    if (typeof record.id === 'string' && isObject(record.video)) {
      const tracks = tracksOf(record.video);
      if (tracks.length) found.set(record.id, tracks);
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}

/** TikTok wraps every video in an element with the id `xgwrapper-<n>-<video id>`; a single video page has it in the URL. */
export function tiktokVideoId(video: HTMLVideoElement, pathname = location.pathname): string | undefined {
  const wrapper = video.closest<HTMLElement>('[id^="xgwrapper-"]');
  const fromWrapper = wrapper?.id.match(/-(\d{6,})$/)?.[1];
  if (fromWrapper) return fromWrapper;
  return pathname.match(/\/video\/(\d{6,})/)?.[1];
}

export function isTikTok(hostname = location.hostname): boolean {
  return /(^|\.)tiktok\.com$/.test(hostname);
}
