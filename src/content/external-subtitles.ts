import type { SubtitleCue } from '../shared/types';
import { normalizeSubtitleText } from './subtitle-text';

export interface RemoteSubtitle {
  language: string;
  url: string;
  /** YouTube only: 'asr' marks auto-generated captions; human-made tracks have no kind. */
  kind?: string;
  youtube?: boolean;
}

const urlPattern = /https?:[^\s,"'<>]+?\.(?:vtt|srt)(?:\?[^\s,"'<>]*)?/giu;
const labelledUrlPattern = /\[(.+?)\]\s*(https?:[^\s,"'<>]+?\.(?:vtt|srt)(?:\?[^\s,"'<>]*)?)/giu;

export function extractRemoteSubtitles(value: unknown): RemoteSubtitle[] {
  const found = new Map<string, RemoteSubtitle>();
  const visit = (item: unknown, hint = 'Unknown') => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(labelledUrlPattern)) found.set(match[2], { language: match[1].trim(), url: match[2] });
      for (const match of item.matchAll(urlPattern)) if (!found.has(match[0])) found.set(match[0], { language: hint, url: match[0] });
      return;
    }
    if (Array.isArray(item)) item.forEach((child) => visit(child, hint));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, child]) => visit(child, key));
  };
  visit(value);
  return [...found.values()];
}

const inlineTimestamp = /<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/;

function cueText(lines: string[]): string {
  return normalizeSubtitleText(lines.join(' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '));
}

export function parseTimedSubtitles(source: string, language?: string): SubtitleCue[] {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const blocks = normalized.split(/\n{2,}/);
  // YouTube auto-generated captions roll: every block repeats the previous line, adds a new line
  // word by word (with inline <00:00:01.234> timings), and 10 ms blocks sit between them.
  // Showing those blocks as they are makes the text and its translation jump every moment.
  const rolling = inlineTimestamp.test(normalized);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startRaw, endRaw] = lines[timingIndex].split('-->');
    const startTime = parseTimestamp(startRaw);
    const endTime = parseTimestamp(endRaw?.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue;
    const body = lines.slice(timingIndex + 1);
    let text: string;
    if (rolling) {
      // Keep only the line being spoken in this block; skip the 10 ms repeat blocks.
      if (endTime - startTime < 0.05) continue;
      const spoken = body.filter((line) => inlineTimestamp.test(line));
      text = cueText(spoken.length ? spoken : body.slice(-1));
    } else {
      text = cueText(body);
    }
    if (!text) continue;
    const previous = cues.at(-1);
    if (rolling && previous && previous.originalText === text) {
      previous.endTime = Math.max(previous.endTime, endTime);
      continue;
    }
    cues.push({ startTime, endTime, originalText: text, sourceLanguage: language });
  }
  if (rolling) {
    // Rolling blocks overlap or leave tiny gaps; end each line exactly where the next one starts,
    // so one line is on screen at a time and nothing blinks out in between.
    for (let index = 0; index < cues.length - 1; index += 1) {
      const nextStart = cues[index + 1].startTime;
      if (cues[index].endTime > nextStart || nextStart - cues[index].endTime < 1) cues[index].endTime = nextStart;
    }
  }
  return cues;
}

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2 || parts.length > 3) return Number.NaN;
  const seconds = parts.pop() ?? 0;
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Puts a second subtitle track (a translation) onto the original cues by time. A cue shows every
 * translated line that substantially overlaps it, so when the two tracks split sentences differently
 * the translation stays on screen for the whole sentence instead of leaving some cues empty.
 */
export function attachTranslations(cues: SubtitleCue[], translations: SubtitleCue[]): SubtitleCue[] {
  let first = 0;
  return cues.map((cue) => {
    while (first < translations.length && translations[first].endTime <= cue.startTime) first += 1;
    const lines: string[] = [];
    for (let index = first; index < translations.length && translations[index].startTime < cue.endTime; index += 1) {
      const line = translations[index];
      const overlap = Math.min(cue.endTime, line.endTime) - Math.max(cue.startTime, line.startTime);
      const shorter = Math.min(cue.endTime - cue.startTime, line.endTime - line.startTime);
      if (overlap > 0 && overlap >= shorter * 0.4 && lines.at(-1) !== line.originalText) lines.push(line.originalText);
    }
    return lines.length ? { ...cue, translatedText: lines.join(' ') } : cue;
  });
}
