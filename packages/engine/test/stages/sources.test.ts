// D-13: classifyUrl only labels a link for the UI badge and error hints; every link uses the same
// yt-dlp path. Only http(s) is valid.

import { describe, expect, test } from 'vitest';
import { classifyUrl } from '../../src/stages/sources.ts';

describe('classifyUrl (D-13)', () => {
  test.each([
    // YouTube: watch, youtu.be, Shorts (+ live, embed, mobile, music)
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'youtube'],
    ['http://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube'],
    ['https://www.youtube.com/shorts/abcDEF12345', 'youtube'],
    ['https://youtube.com/shorts/abcDEF12345?feature=share', 'youtube'],
    ['https://www.youtube.com/live/abcDEF12345', 'youtube'],
    ['https://www.youtube.com/embed/abcDEF12345', 'youtube'],
    ['HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com./watch?v=dQw4w9WgXcQ', 'youtube'],
    // Instagram: reel, post, IGTV (+ user-prefixed forms)
    ['https://www.instagram.com/reel/C1a2B3c4D5e/', 'instagram'],
    ['https://instagram.com/reel/C1a2B3c4D5e', 'instagram'],
    ['https://www.instagram.com/reels/C1a2B3c4D5e/', 'instagram'],
    ['https://www.instagram.com/p/C1a2B3c4D5e/?img_index=1', 'instagram'],
    ['https://www.instagram.com/tv/C1a2B3c4D5e/', 'instagram'],
    ['https://www.instagram.com/someuser/reel/C1a2B3c4D5e/', 'instagram'],
    ['https://www.instagram.com/someuser/p/C1a2B3c4D5e/', 'instagram'],
    // TikTok: video page, vm./vt. short links, /t/ short links, mobile
    ['https://www.tiktok.com/@some.user/video/7301234567890123456', 'tiktok'],
    ['https://tiktok.com/@some_user/video/7301234567890123456?lang=en', 'tiktok'],
    ['https://m.tiktok.com/v/7301234567890123456.html', 'tiktok'],
    ['https://vm.tiktok.com/ZMabc123/', 'tiktok'],
    ['https://vt.tiktok.com/ZSabc123/', 'tiktok'],
    ['https://www.tiktok.com/t/ZTabc123/', 'tiktok'],
    // other http(s): valid for yt-dlp, no badge
    ['https://vimeo.com/123456', 'other'],
    ['https://example.com/video.mp4', 'other'],
    ['https://www.youtube.com/', 'other'],
    ['https://www.youtube.com/@somechannel', 'other'],
    ['https://www.youtube.com/watch', 'other'],
    ['https://www.youtube.com/playlist?list=PL123', 'other'],
    ['https://youtu.be/', 'other'],
    ['https://www.instagram.com/someuser/', 'other'],
    ['https://www.instagram.com/explore/', 'other'],
    ['https://www.tiktok.com/@some.user', 'other'],
    ['https://vm.tiktok.com/', 'other'],
    // look-alike hosts are not the platform
    ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'other'],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'other'],
    ['https://instagram.com.example/reel/C1a2B3c4D5e/', 'other'],
    ['https://evil-tiktok.com/@a/video/1', 'other'],
    // invalid: not http(s), or not a URL
    ['ftp://youtube.com/watch?v=dQw4w9WgXcQ', 'invalid'],
    ['file:///Users/me/video.mp4', 'invalid'],
    ['javascript:alert(1)', 'invalid'],
    ['data:text/html,hi', 'invalid'],
    ['ytsearch:cats', 'invalid'],
    ['www.youtube.com/watch?v=dQw4w9WgXcQ', 'invalid'],
    ['/Users/me/video.mp4', 'invalid'],
    ['', 'invalid'],
    ['   ', 'invalid'],
    ['-o /tmp/x', 'invalid'],
  ] as const)('%s → %s', (url, kind) => {
    expect(classifyUrl(url)).toBe(kind);
  });

  test('surrounding whitespace is ignored', () => {
    expect(classifyUrl('  https://youtu.be/dQw4w9WgXcQ \n')).toBe('youtube');
  });
});
