import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getSettings } from './settings';

const get = vi.fn();

beforeEach(() => {
  get.mockReset();
  vi.stubGlobal('chrome', { storage: { local: { get, set: vi.fn() } } });
});

describe('extension settings', () => {
  it('uses the keyless Chrome translator and stable appearance defaults', async () => {
    get.mockResolvedValue({});
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('clamps stored position values and rejects invalid alignment', async () => {
    get.mockResolvedValue({
      subtitleBottomPercent: 200,
      subtitleHorizontalPercent: -5,
      subtitleBackgroundOpacity: 2,
      subtitleMaxWidthPercent: 10,
      subtitleTextAlign: 'diagonal'
    });
    const settings = await getSettings();
    expect(settings.subtitleBottomPercent).toBe(70);
    expect(settings.subtitleHorizontalPercent).toBe(10);
    expect(settings.subtitleBackgroundOpacity).toBe(0.9);
    expect(settings.subtitleMaxWidthPercent).toBe(50);
    expect(settings.subtitleTextAlign).toBe('center');
  });
});
