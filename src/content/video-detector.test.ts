import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoDetector, detectVideos } from './video-detector';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('detectVideos', () => {
  it('finds HTML5 videos even when no subtitle tracks are exposed', () => {
    document.body.innerHTML = '<video></video><video></video>';

    expect(detectVideos()).toEqual([
      { id: 'lingua-video-0', tracks: [] },
      { id: 'lingua-video-1', tracks: [] }
    ]);
  });

  it('coalesces DOM changes into one scan', async () => {
    const onChange = vi.fn();
    const detector = new VideoDetector(onChange);
    detector.start();
    onChange.mockClear();

    document.body.append(document.createElement('video'));
    document.body.append(document.createElement('video'));
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toHaveLength(2);
    detector.stop();
  });
});
