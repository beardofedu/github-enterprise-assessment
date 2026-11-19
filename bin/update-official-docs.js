import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTPUT = fileURLToPath(new URL('../docs/official-updates.md', import.meta.url));
const START = '<!-- official-updates:start -->';
const END = '<!-- official-updates:end -->';
const SOURCES = [
  { name: 'GitHub Docs', url: 'https://api.github.com/repos/github/docs/commits?per_page=5', type: 'commits' },
  { name: 'GitHub Changelog', url: 'https://github.blog/changelog/feed/', type: 'feed' },
  { name: 'GitHub Blog', url: 'https://github.blog/feed/', type: 'feed' },
];

function decodeEntities(value) {
  const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  return value.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (entity) => entities[entity]);
}

function parseFeed(xml) {
  const entries = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(([, , entry]) => {
    const title = entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    const linkTag = entry.match(/<link\b[^>]*>/i)?.[0] || '';
    const link = linkTag.match(/\bhref=["']([^"']+)["']/i)?.[1] || entry.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    const date = entry.match(/<(?:pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)?.[1]?.trim();
    if (!title || !link) return null;
    try {
      const url = new URL(decodeEntities(link));
      if (url.protocol !== 'https:' || url.hostname !== 'github.blog') return null;
      return { title: decodeEntities(title), url: url.href, date: date ? decodeEntities(date) : '' };
    } catch {
      return null;
    }
  }).filter(Boolean);
  return entries;
}

function renderSource(source, entries) {
  const lines = [`### ${source.name}`, ''];
  if (!entries.length) return [...lines, '_No recent items were returned._', ''].join('\n');
  for (const entry of entries) {
    const date = entry.date ? ` — ${entry.date}` : '';
    lines.push(`- [${entry.title}](${entry.url})${date}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: {
      Accept: source.type === 'commits' ? 'application/vnd.github+json' : 'application/atom+xml, application/rss+xml, application/xml',
      ...(source.type === 'commits' && process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
      'User-Agent': 'github-enterprise-assessment-docs-updater',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error(`${source.name} response exceeded 2 MiB`);
  if (source.type === 'commits') {
    const commits = JSON.parse(body);
    if (!Array.isArray(commits)) throw new Error(`${source.name} returned an invalid response`);
    return commits.slice(0, 5).map((commit) => ({
      title: commit.commit.message.split('\n')[0],
      url: commit.html_url,
      date: commit.commit.author.date.slice(0, 10),
    })).filter((item) => {
      try { return new URL(item.url).hostname === 'github.com' && new URL(item.url).protocol === 'https:'; } catch { return false; }
    });
  }
  return parseFeed(body).slice(0, 5);
}

export async function updateOfficialDocs() {
  const sections = [];
  for (const source of SOURCES) {
    sections.push(renderSource(source, await fetchSource(source)));
  }
  const content = `${START}\nUpdated: ${new Date().toISOString()}\n\n${sections.join('\n')}${END}`;
  const current = readFileSync(OUTPUT, 'utf8');
  const updated = current.replace(new RegExp(`${START}[\\s\\S]*?${END}`), content);
  writeFileSync(OUTPUT, updated);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await updateOfficialDocs();
}

export { parseFeed };
