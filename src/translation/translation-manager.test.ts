import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSettings } = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock('../shared/settings', () => ({ getSettings }));

import { translate } from './translation-manager';

describe('Chrome built-in translation', () => {
  beforeEach(() => {
    getSettings.mockResolvedValue({ translationProvider: 'chrome' });
  });

  it('creates the requested language pair and returns its translation', async () => {
    const translateText = vi.fn(async () => 'Привіт');
    const create = vi.fn(async () => ({ translate: translateText }));
    const availability = vi.fn(async () => 'available');
    vi.stubGlobal('Translator', { availability, create });

    await expect(translate('Hello', 'en', 'uk')).resolves.toMatchObject({ translatedText: 'Привіт', sourceLanguage: 'en', targetLanguage: 'uk' });
    expect(availability).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'uk' });
    expect(create).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'uk' });
    expect(translateText).toHaveBeenCalledWith('Hello');
  });
});
