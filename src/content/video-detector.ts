import type { DetectedTextTrack, DetectedVideo, SubtitleCue } from '../shared/types';

function cueText(cue: TextTrackCue): string {
  return 'text' in cue && typeof cue.text === 'string' ? cue.text.trim() : '';
}

function tracksFor(video: HTMLVideoElement): DetectedTextTrack[] {
  return Array.from(video.textTracks).map((track, index) => {
    const cues: SubtitleCue[] = track.cues
      ? Array.from(track.cues)
          .map((cue) => ({
            startTime: cue.startTime,
            endTime: cue.endTime,
            originalText: cueText(cue),
            sourceLanguage: track.language || undefined
          }))
          .filter((cue) => cue.originalText.length > 0)
      : [];

    return {
      id: `${track.kind}-${track.language || 'und'}-${index}`,
      kind: track.kind,
      label: track.label,
      language: track.language,
      cues
    };
  });
}

export function detectVideos(root: ParentNode = document): DetectedVideo[] {
  return Array.from(root.querySelectorAll('video')).map((video, index) => ({
    id: video.dataset.linguaVideoId ?? `lingua-video-${index}`,
    tracks: tracksFor(video)
  }));
}

export class VideoDetector {
  private observer?: MutationObserver;
  private retryTimer?: number;
  private scheduled = false;
  private readonly mediaStateHandler = (event: Event): void => {
    if (event.target instanceof HTMLVideoElement || event.target instanceof HTMLTrackElement) {
      this.scheduleScan();
    }
  };

  public constructor(private readonly onChange: (videos: DetectedVideo[]) => void) {}

  public start(): void {
    this.scan();
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src'] });
    document.addEventListener('loadedmetadata', this.mediaStateHandler, true);
    document.addEventListener('load', this.mediaStateHandler, true);
    document.addEventListener('play', this.mediaStateHandler, true);
    document.addEventListener('playing', this.mediaStateHandler, true);
    this.retryTimer = window.setInterval(() => this.scheduleScan(), 1000);
  }

  public stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    document.removeEventListener('loadedmetadata', this.mediaStateHandler, true);
    document.removeEventListener('load', this.mediaStateHandler, true);
    document.removeEventListener('play', this.mediaStateHandler, true);
    document.removeEventListener('playing', this.mediaStateHandler, true);
    if (this.retryTimer) window.clearInterval(this.retryTimer);
    this.retryTimer = undefined;
  }

  public scan(): void {
    this.onChange(detectVideos());
  }

  private scheduleScan(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.scan();
    });
  }
}
