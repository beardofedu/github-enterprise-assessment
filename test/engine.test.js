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
