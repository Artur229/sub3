import { describe, expect, it } from 'vitest';
import { attachTranslations, extractRemoteSubtitles, parseTimedSubtitles } from './external-subtitles';

describe('external subtitle discovery', () => {
  it('extracts the labelled list used by Playerjs', () => {
    const result = extractRemoteSubtitles({
      subtitle: '[Русский]https://cdn.example/ru.vtt,[Українська]https://cdn.example/uk.vtt,[English]https://cdn.example/en.vtt'
    });
    expect(result).toEqual([
      { language: 'Русский', url: 'https://cdn.example/ru.vtt' },
      { language: 'Українська', url: 'https://cdn.example/uk.vtt' },
      { language: 'English', url: 'https://cdn.example/en.vtt' }
    ]);
  });

  it('parses WebVTT and SRT timestamps', () => {
    const cues = parseTimedSubtitles('WEBVTT\n\n00:00:16.683 --> 00:00:19.018\nHello<br>friend\n\n2\n00:00:20,000 --> 00:00:22,500\nSecond cue', 'en');
    expect(cues).toEqual([
      { startTime: 16.683, endTime: 19.018, originalText: 'Hello friend', sourceLanguage: 'en' },
      { startTime: 20, endTime: 22.5, originalText: 'Second cue', sourceLanguage: 'en' }
    ]);
  });

  it('turns YouTube rolling auto-captions into one stable line per cue', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      '',
      '00:00:00.000 --> 00:00:02.330 align:start position:0%',
      ' ',
      'group<00:00:00.320><c> anagrams</c><00:00:00.640><c> so</c>',
      '',
      '00:00:02.330 --> 00:00:02.340 align:start position:0%',
      'group anagrams so',
      ' ',
      '',
      '00:00:02.340 --> 00:00:05.000 align:start position:0%',
      'group anagrams so',
      "we're<00:00:02.600><c> given</c><00:00:02.900><c> just</c>",
      ''
    ].join('\n');
    expect(parseTimedSubtitles(vtt, 'en')).toEqual([
      { startTime: 0, endTime: 2.34, originalText: 'group anagrams so', sourceLanguage: 'en' },
      { startTime: 2.34, endTime: 5, originalText: "we're given just", sourceLanguage: 'en' }
    ]);
  });

  it('attaches a translation track by time, also when the tracks split lines differently', () => {
    const cue = (startTime: number, endTime: number, originalText: string) => ({ startTime, endTime, originalText });
    const original = [cue(0, 2, 'So we are given'), cue(2, 4, 'a list of strings.'), cue(6, 8, 'Nothing here.')];
    const sameTimings = attachTranslations(original, [cue(0, 2, 'Отже, нам дано'), cue(2, 4, 'список рядків.')]);
    expect(sameTimings.map((item) => item.translatedText)).toEqual(['Отже, нам дано', 'список рядків.', undefined]);

    const oneLongLine = attachTranslations(original, [cue(0, 4, 'Отже, нам дано список рядків.')]);
    expect(oneLongLine.map((item) => item.translatedText)).toEqual(['Отже, нам дано список рядків.', 'Отже, нам дано список рядків.', undefined]);
  });
});
