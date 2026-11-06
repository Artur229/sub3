import type { DictionaryEntry, TranslationResult } from '../shared/types';

const KEY = 'dictionary';

export async function addDictionaryEntry(result: TranslationResult, context: string): Promise<void> {
  const stored = await chrome.storage.local.get({ [KEY]: [] as DictionaryEntry[] });
  const entries = stored[KEY] as DictionaryEntry[];
  if (entries.some((entry) => entry.text === result.text && entry.targetLanguage === result.targetLanguage)) return;
  const entry: DictionaryEntry = { ...result, id: crypto.randomUUID(), context, addedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [KEY]: [entry, ...entries] });
}
