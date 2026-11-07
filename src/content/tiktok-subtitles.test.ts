import { describe, expect, it } from 'vitest';
import { extractTikTokTracks, isTikTok, tiktokVideoId } from './tiktok-subtitles';

describe('TikTok subtitles', () => {
  it('collects subtitle tracks per video from feed data, from both places TikTok keeps them', () => {
    const feed = {
      itemList: [
        {
          id: '7701697613590072597',
          video: {
            subtitleInfos: [
              { LanguageCodeName: 'eng-US', Url: 'https://cdn.example/en.vtt', Format: 'webvtt', Source: 'ASR' },
              { LanguageCodeName: 'ukr-UA', Url: 'https://cdn.example/uk.vtt', Format: 'webvtt', Source: 'MT' },
              { LanguageCodeName: 'eng-US', Url: 'https://cdn.example/en.json', Format: 'creator_caption' }
            ],
            claInfo: {
              captionInfos: [
                { languageCode: 'eng-US', url: 'https://cdn.example/cla-en.vtt', isAutoGen: true },
                { languageCode: 'deu-DE', url: '', urlList: ['https://cdn.example/de.vtt'], isAutoGen: false }
              ]
            }
          }
        },
        { id: '7654645616496168200', video: { subtitleInfos: [], claInfo: { captionInfos: [], noCaptionReason: 3 } } }
      ]
    };
    const tracks = extractTikTokTracks(feed);
    expect([...tracks.keys()]).toEqual(['7701697613590072597']);
    expect(tracks.get('7701697613590072597')).toEqual([
      { language: 'eng-US', url: 'https://cdn.example/en.vtt', kind: 'asr' },
      { language: 'ukr-UA', url: 'https://cdn.example/uk.vtt', kind: 'mt' },
      { language: 'deu-DE', url: 'https://cdn.example/de.vtt', kind: '' }
    ]);
  });

  it('finds videos in the page data of a single video', () => {
    const page = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { id: '123456789', video: { subtitleInfos: [{ LanguageCodeName: 'eng-US', Url: 'https://cdn.example/a.vtt', Format: 'webvtt' }] } } } } } };
    expect(extractTikTokTracks(page).get('123456789')).toEqual([{ language: 'eng-US', url: 'https://cdn.example/a.vtt', kind: '' }]);
  });

  it('reads the video id from the feed wrapper or from a video page address', () => {
    const wrapper = document.createElement('div');
    wrapper.id = 'xgwrapper-0-7673849508001893652';
    const video = document.createElement('video');
    wrapper.append(document.createElement('div'));
    wrapper.firstElementChild?.append(video);
    expect(tiktokVideoId(video, '/foryou')).toBe('7673849508001893652');
    expect(tiktokVideoId(document.createElement('video'), '/@someone/video/7701697613590072597')).toBe('7701697613590072597');
    expect(tiktokVideoId(document.createElement('video'), '/foryou')).toBeUndefined();
  });

  it('recognises TikTok hosts only', () => {
    expect(isTikTok('www.tiktok.com')).toBe(true);
    expect(isTikTok('tiktok.com')).toBe(true);
    expect(isTikTok('nottiktok.com')).toBe(false);
  });
});
