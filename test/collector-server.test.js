import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { collect } from '../src/collector.js';
import { graphqlUrlFor } from '../src/github-client.js';
import { createServer } from '../src/server.js';
import { loadRubric } from '../src/engine.js';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function mockFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname + u.search });
    let route;
    if (u.pathname === '/graphql') {
      const { query } = JSON.parse(init.body);
      route = routes.graphql(query);
    } else route = routes[u.pathname + u.search] ?? routes[u.pathname];
    if (!route) route = { status: 404, body: { message: 'Not Found' } };
    const status = route.status || 200;
    return {
      ok: status < 400,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'link' ? route.link || null : null) },
      json: async () => route.body,
    };
  };
}

test('collector discovers orgs, paginates, and isolates denied endpoints', async () => {
  const calls = [];
  const routes = {
    graphql: (q) => {
      if (q.includes('organizations')) return { body: { data: { enterprise: { organizations: { nodes: [{ login: 'acme' }], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      if (q.includes('samlIdentityProvider')) return { body: { data: { enterprise: { ownerInfo: { samlIdentityProvider: { id: 'x' } } } } } };
      return { body: { errors: [{ message: 'Field not available' }] } };
    },
    '/orgs/acme': { body: { two_factor_requirement_enabled: true, default_repository_permission: 'read', members_can_create_public_repositories: false } },
    '/orgs/acme/repos': { body: [{ name: 'r1', archived: false, fork: false, pushed_at: new Date().toISOString(), description: 'd', visibility: 'private' }], link: '<https://api.test/orgs/acme/repos?page=2>; rel="next"' },
    '/orgs/acme/repos?page=2': { body: [{ name: 'r2', archived: true, fork: false, pushed_at: null, visibility: 'private' }] },
    '/orgs/acme/members': { status: 403, body: { message: 'Resource not accessible' } },
    '/repos/acme/r1/codeowners/errors': { body: { errors: [] } },
    '/repos/acme/r1/actions/workflows': { body: { total_count: 2 } },
  };
  const ev = await collect({ token: 't', apiUrl: 'https://api.test', enterprise: 'acme-ent', fetchImpl: mockFetch(routes, calls) });

  assert.deepEqual(ev.meta.organizations, ['acme']);
  assert.equal(ev.enterprise.saml.ok, true);
  assert.equal(ev.enterprise.saml.data, true);
  assert.equal(ev.enterprise.twoFactor.ok, false);
  const org = ev.orgs.acme;
  assert.equal(org.settings.ok, true);
  assert.equal(org.repos.data.items.length, 2);
  assert.equal(org.owners.ok, false);
  assert.equal(org.owners.status, 403);
  assert.deepEqual(org.repoSample.data, [{ name: 'r1', codeowners: { ok: true, data: true }, workflows: { ok: true, data: 2 } }]);
  assert.equal(org.communityFiles.data.securityPolicy, false);
  assert.ok(calls.every((c) => c.method === 'GET' || c.path === '/graphql'), 'only read operations are issued');
});

test('graphql URL is derived for GHES and github.com', () => {
  assert.equal(graphqlUrlFor('https://ghe.example.com/api/v3'), 'https://ghe.example.com/api/graphql');
  assert.equal(graphqlUrlFor('https://api.github.com'), 'https://api.github.com/graphql');
});

test('dashboard and HTML reports explain missing Primer before starting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'waf-no-primer-'));
  try {
    for (const name of ['src', 'bin', 'rubric', 'examples']) {
      cpSync(new URL(`../${name}`, import.meta.url), join(dir, name), { recursive: true });
    }
    copyFileSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
    const options = {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
      timeout: 5000,
    };
    for (const args of [
      ['serve', '--demo'],
      ['run', '--enterprise', 'example'],
      ['assess', '--evidence', 'examples/sample-evidence.json', '--format', 'html'],
    ]) {
      const result = spawnSync(process.execPath, ['bin/gh-waf-assess.js', ...args], options);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Primer CSS is missing.*npm ci/);
    }
    const markdown = spawnSync(process.execPath, ['bin/gh-waf-assess.js', 'assess', '--evidence', 'examples/sample-evidence.json', '--format', 'md'], options);
    assert.ifError(markdown.error);
    assert.equal(markdown.status, 0, markdown.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard server persists answers and rejects foreign hosts and non-JSON posts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waf-'));
  const answersPath = join(dir, 'answers.json');
  const rubric = loadRubric();
  const server = createServer({ rubric, evidence: { orgs: {} }, answersPath, port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // Recreate with the real port so the Host allow list matches.
  server.close();
  const real = createServer({ rubric, evidence: { orgs: {} }, answersPath, port });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const stylesheet = await fetch(`${base}/primer.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);
    assert.match(await stylesheet.text(), /\.UnderlineNav/);

    const post = await fetch(`${base}/api/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'GOV-11', answer: 'yes', notes: 'quarterly' }) });
    assert.equal(post.status, 200);
    const assessment = await post.json();
    assert.equal(assessment.controls.find((c) => c.id === 'GOV-11').status, 'pass');
    assert.deepEqual(JSON.parse(readFileSync(answersPath, 'utf8'))['GOV-11'], { answer: 'yes', notes: 'quarterly' });

    const bad = await fetch(`${base}/api/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'GOV-11', answer: 'maybe' }) });
    assert.equal(bad.status, 400);
    const form = await fetch(`${base}/api/answers`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    const rebindStatus = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/assessment', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(rebindStatus, 403);
  } finally {
    real.close();
  }
});
