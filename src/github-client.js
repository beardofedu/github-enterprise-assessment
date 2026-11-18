import { execFileSync } from 'node:child_process';

export function resolveToken(explicit) {
  if (explicit) return explicit;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function graphqlUrlFor(apiUrl) {
  const base = apiUrl.replace(/\/+$/, '');
  if (base.endsWith('/api/v3')) return base.replace(/\/api\/v3$/, '/api/graphql');
  return `${base}/graphql`;
}

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Minimal read-only GitHub REST/GraphQL client (GET + GraphQL queries only). */
export class GitHubClient {
  constructor({ token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error('A GitHub token is required (set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`).');
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.graphqlUrl = graphqlUrlFor(this.apiUrl);
    this.fetch = fetchImpl;
    this.requestCount = 0;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-enterprise-assessment',
    };
  }

  async request(pathOrUrl) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    this.requestCount++;
    const res = await this.fetch(url, { headers: this.headers() });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message || '';
      } catch {
        /* ignore non-JSON bodies */
      }
      throw new GitHubError(`GET ${url.replace(this.apiUrl, '')} -> ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }
    const data = res.status === 204 ? null : await res.json();
    return { data, link: res.headers.get('link') };
  }

  async get(path) {
    return (await this.request(path)).data;
  }

  /** Follows Link rel="next" pagination. `pick` extracts the array from wrapped responses. */
  async paginate(path, { max = 1000, pick } = {}) {
    const items = [];
    let next = path;
    let truncated = false;
    while (next) {
      const { data, link } = await this.request(next);
      const page = pick ? pick(data) : data;
      items.push(...(page || []));
      if (items.length >= max) {
        truncated = Boolean(link && /rel="next"/.test(link)) || items.length > max;
        break;
      }
      const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1] : null;
    }
    return { items: items.slice(0, max), truncated };
  }

  async graphql(query, variables = {}) {
    this.requestCount++;
    const res = await this.fetch(this.graphqlUrl, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GitHubError(`GraphQL -> ${res.status}: ${body.message || ''}`, res.status);
    if (body.errors?.length) throw new GitHubError(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  }
}
