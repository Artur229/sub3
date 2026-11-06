import type { TranslationResult } from '../shared/types';

const DB_NAME = 'sub3';
const STORE_NAME = 'translations';
const CACHE_VERSION = 'quality-v2';

function key(text: string, sourceLanguage: string, targetLanguage: string, namespace: string, context = ''): string {
  return `${CACHE_VERSION}:${namespace}:${sourceLanguage}:${targetLanguage}:${text.trim().toLocaleLowerCase()}:${context.trim().toLocaleLowerCase()}`;
}

export class TranslationCache {
  private database?: Promise<IDBDatabase>;

  async get(text: string, sourceLanguage: string, targetLanguage: string, namespace: string, context = ''): Promise<TranslationResult | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key(text, sourceLanguage, targetLanguage, namespace, context));
      request.onsuccess = () => resolve(request.result as TranslationResult | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async put(result: TranslationResult, namespace: string, context = ''): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({
        ...result,
        id: key(result.text, result.sourceLanguage, result.targetLanguage, namespace, context)
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.database;
  }
}
