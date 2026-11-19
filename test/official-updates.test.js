import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../bin/update-official-docs.js';

test('official update feed parser extracts safe GitHub blog links', () => {
  const xml = `<?xml version="1.0"?>
    <rss><channel>
      <item><title><![CDATA[Actions &amp; security]]></title><link>https://github.blog/changelog/actions/</link><pubDate>Wed, 18 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>Untrusted</title><link>https://example.com/not-github</link></item>
      <item><title>Missing link</title></item>
    </channel></rss>`;

  assert.deepEqual(parseFeed(xml), [{
    title: 'Actions & security',
    url: 'https://github.blog/changelog/actions/',
    date: 'Wed, 18 Nov 2026 10:00:00 GMT',
  }]);
});
