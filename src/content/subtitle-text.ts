export function normalizeSubtitleText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/(\b\d{1,2}:\d{2})(?=[\p{L}])/gu, '$1 ')
    .replace(/,(?=[\p{L}"“])/gu, ', ')
    .replace(/([;!?])(?=[\p{L}\d"“])/gu, '$1 ')
    .replace(/:(?=[\p{L}"“])/gu, ': ')
    .replace(/([.!?])(?=[\p{Lu}\d"“])/gu, '$1 ')
    .trim();
}

