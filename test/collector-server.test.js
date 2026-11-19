import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { collect, EnterpriseUnavailableError } from '../src/collector.js';
import { GitHubClient, graphqlUrlFor } from '../src/github-client.js';
import { createServer } from '../src/server.js';
import { loadRubric } from '../src/engine.js';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  const logs = [];
  const routes = {
    graphql: (q) => {
      if (q.includes('organizations')) return { body: { data: { enterprise: { organizations: { nodes: [{ login: 'acme' }], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      if (q.includes('samlIdentityProvider')) return { body: { data: { enterprise: { ownerInfo: { samlIdentityProvider: { id: 'x' } } } } } };
      return { body: { errors: [{ message: 'Field not available' }] } };
    },
    '/orgs/acme': { body: { public_repos: 2, total_private_repos: 1, two_factor_requirement_enabled: true, default_repository_permission: 'read', members_can_create_public_repositories: false } },
    '/orgs/acme/repos': { body: [{ name: 'r1', archived: false, fork: false, pushed_at: new Date().toISOString(), description: 'd', visibility: 'private' }], link: '<https://api.test/orgs/acme/repos?page=2>; rel="next"' },
    '/orgs/acme/repos?page=2': { body: [{ name: 'r2', archived: true, fork: false, pushed_at: null, visibility: 'private' }] },
    '/orgs/acme/members': { status: 403, body: { message: 'Resource not accessible' } },
    '/repos/acme/r1/codeowners/errors': { body: { errors: [] } },
    '/repos/acme/r1/actions/workflows': { body: { total_count: 2 } },
  };
  const ev = await collect({ token: 't', apiUrl: 'https://api.test', enterprise: 'acme-ent', durationMinutes: 0.001, fetchImpl: mockFetch(routes, calls), log: (msg) => logs.push(msg) });

  assert.deepEqual(ev.meta.organizations, ['acme']);
  assert.deepEqual(ev.meta.footprint, {
    organizations: 1,
    repositories: 3,
    knownRepositories: 3,
    organizationsWithUnknownRepositoryCount: [],
  });
  assert.ok(ev.meta.estimatedRequestCount > ev.meta.requestCount);
  assert.ok(ev.meta.requestIntervalMs > 0);
  assert.ok(logs.some((msg) => /Pacing requests for approximately/.test(msg)));
  assert.ok(logs.some((msg) => /Footprint: 1 organization\(s\), 3 repositories/.test(msg)));
  assert.equal(calls.filter((call) => call.path === '/orgs/acme').length, 1, 'preflight metadata is reused during collection');
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

test('GitHub client spaces concurrent request starts when configured', async () => {
  const started = [];
  const client = new GitHubClient({
    token: 't',
    apiUrl: 'https://api.test',
    requestIntervalMs: 20,
    fetchImpl: async () => {
      started.push(Date.now());
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    },
  });

  await Promise.all([client.get('/first'), client.get('/second')]);
  client.setRequestIntervalMs(30);
  await client.get('/third');

  assert.equal(started.length, 3);
  assert.ok(started[1] - started[0] >= 15);
  assert.ok(started[2] - started[1] >= 25);
});

test('collector stops when the enterprise is unavailable unless token-org fallback is allowed', async () => {
  const routes = {
    graphql: () => ({ body: { data: { enterprise: null } } }),
    '/user/orgs': { body: [{ login: 'mine' }] },
  };
  await assert.rejects(
    collect({ token: 't', apiUrl: 'https://api.test', enterprise: 'nope', fetchImpl: mockFetch(routes) }),
    (err) => err instanceof EnterpriseUnavailableError && err.enterprise === 'nope' && /not found or not accessible/.test(err.message),
  );
  const ev = await collect({ token: 't', apiUrl: 'https://api.test', enterprise: 'nope', tokenOrgFallback: true, sampleSize: 0, fetchImpl: mockFetch(routes) });
  assert.deepEqual(ev.meta.organizations, ['mine']);
  assert.equal(ev.meta.orgDiscovery.ok, false);
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
    const guide = await fetch(`${base}/implementation-guide`);
    assert.equal(guide.status, 200);
    assert.match(guide.headers.get('content-type'), /text\/html/);
    const guideHtml = await guide.text();
    assert.match(guideHtml, /Assessment dashboard/);
    assert.match(guideHtml, /dashboard actions are read-only with respect to GitHub settings/);
    assert.match(guideHtml, /href="\/official-updates"/);
    const updates = await fetch(`${base}/official-updates`);
    assert.equal(updates.status, 200);
    assert.match(updates.headers.get('content-type'), /text\/html/);
    assert.match(await updates.text(), /Official GitHub updates/);

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

test('sample evidence cannot trigger GitHub setting writes', async (t) => {
  const rubric = loadRubric();
  const evidence = { meta: { sample: true, organizations: ['acme'] }, orgs: {} };
  const portProbe = http.createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const { port } = portProbe.address();
  await new Promise((resolve) => portProbe.close(resolve));
  const server = createServer({ rubric, evidence, port });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/api/implement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ controlId: 'GOV-05', organization: 'acme', token: 'test-token', confirmed: true }),
  });
  assert.equal(response.status, 404);
});

test('dashboard imports answers atomically, preserves other answers, and reloads them on startup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'waf-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const answersPath = join(dir, 'answers.json');
  writeFileSync(answersPath, JSON.stringify({ 'GOV-11': 'no', 'ARC-03': 'partial' }));
  const rubric = loadRubric();
  const start = async () => {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const server = createServer({ rubric, evidence: { orgs: {} }, answersPath, port });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return (path, body, type = 'application/json') => fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': type },
      ...(body === undefined ? {} : { method: 'POST', body }),
    });
  };
  const request = await start();
  const initial = await (await request('/api/assessment')).json();
  assert.equal(initial.controls.find((c) => c.id === 'GOV-11').status, 'fail');

  const response = await request('/api/answers/import', JSON.stringify({
    'GOV-11': { answer: 'yes', notes: 'Quarterly review' },
    'GOV-12': 'na',
    'GOV-03': 'partial',
  }));
  assert.equal(response.status, 200);
  const assessment = await response.json();
  assert.equal(assessment.controls.find((c) => c.id === 'GOV-11').status, 'pass');
  assert.equal(assessment.controls.find((c) => c.id === 'GOV-11').notes, 'Quarterly review');
  assert.equal(assessment.controls.find((c) => c.id === 'GOV-12').status, 'not_applicable');
  assert.equal(assessment.controls.find((c) => c.id === 'GOV-03').source, 'manual-override');
  assert.equal(assessment.controls.find((c) => c.id === 'ARC-03').status, 'partial');
  const saved = readFileSync(answersPath, 'utf8');
  assert.deepEqual(JSON.parse(saved)['GOV-11'], { answer: 'yes', notes: 'Quarterly review' });

  for (const body of [
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ 'GOV-11': 'no', 'INVALID': 'yes' }),
    JSON.stringify({ 'GOV-11': 'maybe' }),
    JSON.stringify({ 'GOV-11': null }),
    JSON.stringify({ 'GOV-11': { answer: { toString: 'yes' } } }),
    JSON.stringify({ 'GOV-11': { answer: 'yes', notes: {} } }),
    JSON.stringify({ 'GOV-11': { answer: 'yes', notes: false } }),
    JSON.stringify({ 'GOV-11': { answer: 'yes', notes: 'x'.repeat(4001) } }),
    JSON.stringify({ controls: [] }),
  ]) {
    assert.equal((await request('/api/answers/import', body)).status, 400, body);
    assert.equal(readFileSync(answersPath, 'utf8'), saved);
  }
  assert.equal((await request('/api/answers/import', '{}', 'text/plain')).status, 415);
  const unchanged = await (await request('/api/assessment')).json();
  assert.equal(unchanged.controls.find((c) => c.id === 'GOV-11').status, 'pass');
  const restarted = await start();
  const reloaded = await (await restarted('/api/assessment')).json();
  assert.equal(reloaded.controls.find((c) => c.id === 'GOV-11').notes, 'Quarterly review');
  assert.equal(reloaded.controls.find((c) => c.id === 'ARC-03').status, 'partial');

  mkdirSync(`${answersPath}.tmp`);
  assert.equal((await request('/api/answers/import', '{"GOV-11":"no"}')).status, 500);
  assert.equal(readFileSync(answersPath, 'utf8'), saved);
  const afterSaveError = await (await request('/api/assessment')).json();
  assert.equal(afterSaveError.controls.find((c) => c.id === 'GOV-11').status, 'pass');
});
