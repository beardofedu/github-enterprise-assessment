import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assess, loadRubric, validateRubric } from '../src/engine.js';
import { checks } from '../src/checks.js';
import { renderHtml, renderMarkdown } from '../src/report.js';

const rubric = loadRubric();
const sample = JSON.parse(readFileSync(new URL('../examples/sample-evidence.json', import.meta.url), 'utf8'));
const byId = (a, id) => a.controls.find((c) => c.id === id);

test('built-in rubric covers all five pillars and every automated control has a check', () => {
  assert.deepEqual(rubric.pillars.map((p) => p.id), ['governance', 'application-security', 'architecture', 'collaboration', 'productivity']);
  for (const p of rubric.pillars) assert.ok(rubric.controls.some((c) => c.pillar === p.id && c.type === 'manual'), `${p.id} has manual controls`);
  for (const p of rubric.pillars) assert.ok(rubric.controls.some((c) => c.pillar === p.id && c.type === 'automated'), `${p.id} has automated controls`);
});

test('validateRubric rejects automated controls without checks', () => {
  const bad = { ...rubric, controls: [...rubric.controls, { id: 'X-1', pillar: 'governance', type: 'automated', weight: 1, title: 'x' }] };
  assert.throws(() => validateRubric(bad), /no check implementation/);
});

test('sample evidence yields mixed statuses across organizations', () => {
  const a = assess({ rubric, evidence: sample });
  assert.equal(byId(a, 'GOV-01').status, 'pass');
  assert.equal(byId(a, 'GOV-03').status, 'fail');
  assert.equal(byId(a, 'GOV-05').status, 'partial');
  assert.match(byId(a, 'GOV-05').finding, /octo-retail \(base permission 'write'\)/);
  assert.equal(byId(a, 'GOV-07').status, 'partial');
  assert.equal(byId(a, 'SEC-09').status, 'partial');
  assert.equal(byId(a, 'PRD-02').status, 'pass');
  assert.equal(byId(a, 'GOV-11').status, 'unanswered');
});

test('unknown and unanswered controls are excluded from scores and listed as coverage gaps', () => {
  const evidence = { meta: {}, enterprise: null, orgs: {} };
  const a = assess({ rubric, evidence });
  assert.equal(a.overall.score, null);
  assert.equal(a.overall.coverage, 0);
  assert.equal(a.improvements.length, 0);
  assert.equal(a.coverageGaps.length, rubric.controls.length);
});

test('weighted scoring and manual answers', () => {
  const tiny = {
    ...rubric,
    controls: [
      { id: 'M-1', pillar: 'governance', area: 'x', title: 'a', type: 'manual', weight: 3, question: 'q', remediation: 'r' },
      { id: 'M-2', pillar: 'governance', area: 'x', title: 'b', type: 'manual', weight: 1, question: 'q', remediation: 'r' },
      { id: 'M-3', pillar: 'governance', area: 'x', title: 'c', type: 'manual', weight: 2, question: 'q', remediation: 'r' },
    ],
  };
  const a = assess({ rubric: tiny, evidence: { orgs: {} }, answers: { 'M-1': 'yes', 'M-2': { answer: 'partial', notes: 'n' }, 'M-3': 'na' } });
  assert.equal(a.overall.score, 87.5); // (3*1 + 1*0.5) / 4
  assert.equal(a.overall.maturity.name, 'Managed');
  assert.equal(byId(a, 'M-3').status, 'not_applicable');
  assert.equal(a.overall.applicableControls, 2);
  assert.deepEqual(a.improvements.map((i) => i.id), ['M-2']);
  assert.equal(byId(a, 'M-2').notes, 'n');
});

test('assessor answers can fill in automated controls the token could not evaluate', () => {
  const evidence = { orgs: {}, enterprise: null };
  const a = assess({ rubric, evidence, answers: { 'GOV-03': 'yes', 'GOV-01': 'no' } });
  assert.equal(byId(a, 'GOV-03').status, 'pass');
  assert.equal(byId(a, 'GOV-03').source, 'manual-override');
  assert.equal(byId(a, 'GOV-01').status, 'fail');
});

test('improvements are ranked by weight times gap', () => {
  const a = assess({ rubric, evidence: sample });
  for (let i = 1; i < a.improvements.length; i++) assert.ok(a.improvements[i - 1].priority >= a.improvements[i].priority);
  assert.equal(a.improvements[0].severity, 'High');
});

test('checks report unknown when an org endpoint was denied', () => {
  const ev = { orgs: { a: { settings: { ok: false, error: 'Must be an org owner', status: 403 } } } };
  const r = checks['GOV-05'](ev);
  assert.equal(r.status, 'unknown');
  assert.match(r.finding, /Must be an org owner/);
});

test('organization breakdown includes enabled, disabled, and unassessed organizations', () => {
  const evidence = { orgs: {
    enabled: { settings: { ok: true, data: { two_factor_requirement_enabled: true } } },
    disabled: { settings: { ok: true, data: { two_factor_requirement_enabled: false } } },
    unavailable: { settings: { ok: false, error: 'Access denied' } },
  } };
  const result = checks['GOV-02'](evidence);
  assert.match(result.finding, /^1 of 2 organizations meet/);
  assert.deepEqual(result.details.breakdown.labels, { pass: 'Enabled', fail: 'Disabled' });
  assert.deepEqual(result.details.breakdown.items, [
    { name: 'enabled', status: 'pass', note: undefined },
    { name: 'disabled', status: 'fail', note: undefined },
    { name: 'unavailable', status: 'unknown', note: 'Access denied' },
  ]);
});

test('repository breakdown distinguishes disabled settings from missing evidence', () => {
  const repo = (name, security_and_analysis, extra = {}) => ({ name, security_and_analysis, ...extra });
  const evidence = { orgs: {
    acme: { repos: { ok: true, data: { truncated: true, items: [
      repo('enabled', { secret_scanning_push_protection: { status: 'enabled' } }),
      repo('disabled', { secret_scanning_push_protection: { status: 'disabled' } }),
      repo('missing-feature', {}),
      repo('missing-settings', null),
      repo('archived', {}, { archived: true }),
      repo('fork', {}, { fork: true }),
    ] } } },
    unavailable: { repos: { ok: false, error: 'Access denied' } },
  } };
  const result = checks['SEC-02'](evidence);
  assert.match(result.finding, /^1 of 3 active repositories/);
  const breakdown = result.details.breakdown;
  assert.deepEqual(breakdown.items.map(({ name, status }) => ({ name, status })), [
    { name: 'acme/enabled', status: 'pass' },
    { name: 'acme/disabled', status: 'fail' },
    { name: 'acme/missing-feature', status: 'unknown' },
    { name: 'acme/missing-settings', status: 'unknown' },
  ]);
  assert.match(breakdown.items[2].note, /counted as not enabled/);
  assert.match(breakdown.items[3].note, /excluded from the score/);
  assert.equal(breakdown.truncated, true);
  assert.deepEqual(breakdown.unavailable, ['unavailable']);
});

test('sampled repository breakdown marks denied and unsampled checks as unassessed', () => {
  const evidence = { orgs: { acme: {
    repos: { ok: true, data: { truncated: false, items: ['present', 'absent', 'denied', 'unsampled'].map((name) => ({ name })) } },
    repoSample: { ok: true, data: [
      { name: 'present', codeowners: { ok: true, data: true } },
      { name: 'absent', codeowners: { ok: true, data: false } },
      { name: 'denied', codeowners: { ok: false, error: 'Access denied' } },
    ] },
  } } };
  const result = checks['COL-01'](evidence);
  assert.match(result.finding, /^1 of 2 sampled active repositories/);
  assert.deepEqual(result.details.breakdown.items, [
    { name: 'acme/present', status: 'pass' },
    { name: 'acme/absent', status: 'fail' },
    { name: 'acme/denied', status: 'unknown', note: 'Access denied' },
    { name: 'acme/unsampled', status: 'unknown', note: 'Not included in the repository sample.' },
  ]);
  assert.equal(result.details.breakdown.sampled, true);
});

test('ARC-01 is not applicable without self-hosted runners', () => {
  const r = checks['ARC-01']({ orgs: { a: { selfHostedRunners: { ok: true, data: 0 } } } });
  assert.equal(r.status, 'not_applicable');
});

test('GOV-02 falls back to organization settings when the enterprise policy is not set', () => {
  const ev = { enterprise: { twoFactor: { ok: true, data: 'NO_POLICY' }, oidc: { ok: true, data: false } }, orgs: { a: { settings: { ok: true, data: { two_factor_requirement_enabled: true } } } } };
  assert.equal(checks['GOV-02'](ev).status, 'pass');
});

test('reports render and HTML embedding escapes script-breaking content', () => {
  const a = assess({ rubric, evidence: sample, answers: { 'GOV-11': { answer: 'no', notes: '</script><script>alert(1)</script>' } } });
  const md = renderMarkdown(a);
  assert.match(md, /## Prioritized improvement areas/);
  const html = renderHtml(a);
  assert.ok(html.includes('window.__ASSESSMENT__'));
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('.UnderlineNav'));
  assert.ok(!html.includes('<link rel="stylesheet" href="/primer.css">'));
});

test('Markdown table cells escape backslashes before pipe delimiters', () => {
  const a = assess({ rubric, evidence: sample });
  a.controls[0].finding = String.raw`first\|second|third`;
  const md = renderMarkdown(a);
  const escapedCell = String.raw`first\\\|second\|third`;
  assert.ok(md.includes(`| ${escapedCell} |`));
});

test('access-denied coverage gaps avoid double periods and include a gh auth refresh command', () => {
  const error = 'GET /orgs/acme/actions/runners?per_page=1 -> 403: You must be an org admin or have the runners and runner groups fine-grained permission.';
  const evidence = { meta: { apiUrl: 'https://api.acme.ghe.com' }, enterprise: null, orgs: { acme: { selfHostedRunners: { ok: false, error, status: 403 } } } };
  const a = assess({ rubric, evidence });
  const gap = a.coverageGaps.find((g) => g.id === 'ARC-01');
  assert.equal(gap.finding, `Could not evaluate scoped self-hosted runner groups: ${error}`);
  assert.deepEqual(gap.access, {
    scopes: ['admin:org'],
    command: 'gh auth refresh -h acme.ghe.com -s admin:org',
    requiresOwner: true,
    requiresRepositoryAdmin: false,
    requiresSecurityManager: false,
  });
  assert.match(a.coverageAccess.command, /^gh auth refresh -h acme\.ghe\.com -s .*admin:org/);
  assert.match(renderMarkdown(a), /```sh\ngh auth refresh -h acme\.ghe\.com -s /);
});

test('repository-security access gaps identify repository administrator prerequisites', () => {
  const error = 'repository security settings were not returned (the token needs admin access to repositories)';
  const evidence = { meta: { apiUrl: 'https://api.github.com' }, orgs: { acme: {
    repos: { ok: true, data: { truncated: false, items: [{ name: 'private-repo' }] } },
    repoSecurity: { ok: false, error, status: 403 },
  } } };
  const a = assess({ rubric, evidence });
  const gap = a.coverageGaps.find((item) => item.id === 'SEC-01');
  assert.equal(gap.access.requiresRepositoryAdmin, true);
  assert.equal(gap.access.requiresOwner, false);
  assert.equal(gap.access.requiresSecurityManager, false);
  assert.match(renderMarkdown(a), /must also have repository administrator access/);
});
