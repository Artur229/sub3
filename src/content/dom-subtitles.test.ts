import { describe, expect, it } from 'vitest';
import { findSubtitleDomSource, readSubtitleDomText } from './dom-subtitles';

describe('DOM subtitle fallback', () => {
  it('reads and joins YouTube caption segments', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <span class="ytp-caption-segment">Welcome to</span>
        <span class="ytp-caption-segment"> YouTube.</span>
      </div>`;
    const source = findSubtitleDomSource();

    expect(source?.player).toBe('youtube');
    expect(source && readSubtitleDomText(source)).toBe('Welcome to YouTube.');
  });

  it('does not duplicate repeated YouTube segments', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <span class="ytp-caption-segment">Same line</span>
        <span class="ytp-caption-segment">Same line</span>
      </div>`;
    const source = findSubtitleDomSource();

    expect(source && readSubtitleDomText(source)).toBe('Same line');
  });

  it('repairs sentence boundaries concatenated by a player', () => {
    document.body.innerHTML = '<div id="pjs_cdnplayer_subtitle"><span>Where you are headed.A billion-dollar valuation.</span></div>';
    const source = findSubtitleDomSource();

    expect(source && readSubtitleDomText(source)).toBe('Where you are headed. A billion-dollar valuation.');
  });

  it('repairs words concatenated after a timestamp or punctuation', () => {
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <span class="ytp-caption-segment">I'm interviewing interns at 10:00tomorrow,and then leaving.</span>
      </div>`;
    const source = findSubtitleDomSource();

    expect(source && readSubtitleDomText(source)).toBe("I'm interviewing interns at 10:00 tomorrow, and then leaving.");
  });

  it('keeps a space where Playerjs uses a br element', () => {
    document.body.innerHTML = '<div id="pjs_cdnplayer_subtitle"><span>I opened a new account<br>and put $18,000 in it.</span></div>';
    const source = findSubtitleDomSource();

    expect(source && readSubtitleDomText(source)).toBe('I opened a new account and put $18,000 in it.');
  });
});

