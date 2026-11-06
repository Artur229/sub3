export type SubtitleDomPlayer = 'playerjs' | 'jwplayer' | 'youtube';

export interface SubtitleDomSource {
  container: HTMLElement;
  player: SubtitleDomPlayer;
}

function textWithLineBreaks(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('br').forEach((breakElement) => breakElement.replaceWith(' '));
  return copy.textContent ?? '';
}

export function findSubtitleDomSource(root: ParentNode = document): SubtitleDomSource | undefined {
  const playerjs = root.querySelector<HTMLElement>('#pjs_cdnplayer_subtitle');
  if (playerjs?.isConnected) return { container: playerjs, player: 'playerjs' };

  const jwplayer = root.querySelector<HTMLElement>('.jw-text-track-display');
  if (jwplayer?.isConnected) return { container: jwplayer, player: 'jwplayer' };

  const youtube = root.querySelector<HTMLElement>('.ytp-caption-window-container');
  if (youtube?.isConnected) return { container: youtube, player: 'youtube' };
}

export function readSubtitleDomText(source: SubtitleDomSource): string {
  if (source.player !== 'youtube') {
    const element = source.container.querySelector<HTMLElement>('span') ?? source.container;
    return normalizeSubtitleText(textWithLineBreaks(element));
  }

  const segments = Array.from(source.container.querySelectorAll<HTMLElement>('.ytp-caption-segment'))
    .map((segment) => normalizeSubtitleText(textWithLineBreaks(segment)))
    .filter(Boolean);
  const uniqueSegments = segments.filter((segment, index) => index === 0 || segment !== segments[index - 1]);
  return normalizeSubtitleText(uniqueSegments.join(' '));
}

import { normalizeSubtitleText } from './subtitle-text';

