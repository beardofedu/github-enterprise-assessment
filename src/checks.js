// Each check maps collected evidence to { status, finding, details }.
// status: pass | partial | fail | unknown | not_applicable

const STALE_DAYS = 365;
const SCORE = { pass: 1, partial: 0.5, fail: 0 };

const result = (status, finding, details = {}) => ({ status, finding, details });
const pct = (n) => `${Math.round(n * 100)}%`;
const listSome = (arr, n = 5) => (arr.length > n ? `${arr.slice(0, n).join(', ')} (+${arr.length - n} more)` : arr.join(', '));

function orgEntries(evidence) {
  return Object.entries(evidence.orgs || {});
}

/** Evaluates fn per organization and rolls the results into one enterprise-wide status. */
export function perOrg(evidence, key, fn, label) {
  const orgs = orgEntries(evidence);
  if (!orgs.length) return result('unknown', 'No organizations were collected.');
  const outcomes = [];
  const unknown = [];
  for (const [name, org] of orgs) {
    const probe = org[key];
    if (!probe?.ok) {
      unknown.push({ org: name, reason: probe?.error || 'not collected' });
      continue;
    }
    const r = fn(probe.data, name, org);
    if (r.status === 'unknown') unknown.push({ org: name, reason: r.note || 'not determinable' });
    else outcomes.push({ org: name, ...r });
  }
  const assessed = outcomes.filter((o) => o.status !== 'not_applicable');
  if (!assessed.length) {
    if (outcomes.length) return result('not_applicable', `Not applicable to the collected organizations (${outcomes.map((o) => o.note).filter(Boolean)[0] || 'no relevant configuration'}).`, { orgs: outcomes });
    return result('unknown', `Could not evaluate ${label}: ${unknown[0]?.reason || 'no data'}.`, { unknown });
  }
  const avg = assessed.reduce((s, o) => s + SCORE[o.status], 0) / assessed.length;
  const status = avg === 1 ? 'pass' : avg === 0 ? 'fail' : 'partial';
  const passing = assessed.filter((o) => o.status === 'pass').length;
  const gaps = assessed.filter((o) => o.status !== 'pass').map((o) => (o.note ? `${o.org} (${o.note})` : o.org));
  let finding = `${passing} of ${assessed.length} organizations meet ${label}.`;
  if (gaps.length) finding += ` Gaps: ${listSome(gaps)}.`;
  if (unknown.length) finding += ` Not assessed: ${listSome(unknown.map((u) => u.org))}.`;
  return result(status, finding, { orgs: outcomes, unknown, score: avg });
}

function activeRepos(evidence) {
  const repos = [];
  const unavailable = [];
  let truncated = false;
  for (const [name, org] of orgEntries(evidence)) {
    if (!org.repos?.ok) {
      unavailable.push(name);
      continue;
    }
    truncated ||= org.repos.data.truncated;
    for (const r of org.repos.data.items) if (!r.archived && !r.fork) repos.push({ org: name, ...r });
  }
  return { repos, unavailable, truncated };
}

function sampledRepos(evidence) {
  const out = [];
  for (const [name, org] of orgEntries(evidence)) if (org.repoSample?.ok) for (const r of org.repoSample.data) out.push({ org: name, ...r });
  return out;
}

export function coverage(ratio, { pass, partial }) {
  return ratio >= pass ? 'pass' : ratio >= partial ? 'partial' : 'fail';
}

function repoCoverage(evidence, predicate, { label, pass = 0.9, partial = 0.5, requireSecurity = false }) {
  const { repos, unavailable, truncated } = activeRepos(evidence);
  const scoped = requireSecurity ? repos.filter((r) => r.security_and_analysis) : repos;
  if (!scoped.length) {
    const why = requireSecurity && repos.length ? 'repository security settings were not returned (the token needs admin access to repositories)' : 'no active repositories were collected';
    return result('unknown', `Could not evaluate ${label}: ${why}.`, { unavailable });
  }
  const matching = scoped.filter(predicate).length;
  const ratio = matching / scoped.length;
  let finding = `${matching} of ${scoped.length} active repositories (${pct(ratio)}) ${label}.`;
  if (truncated) finding += ' Repository inventory was truncated by --max-repos.';
  return result(coverage(ratio, { pass, partial }), finding, { matching, total: scoped.length, ratio });
}

function sampleCoverage(evidence, field, predicate, { label, pass, partial }) {
  const sample = sampledRepos(evidence).filter((r) => r[field]?.ok);
  if (!sample.length) return result('unknown', `Could not evaluate ${label}: no repository sample was collected.`);
  const matching = sample.filter((r) => predicate(r[field].data)).length;
  const ratio = matching / sample.length;
  return result(coverage(ratio, { pass, partial }), `${matching} of ${sample.length} sampled active repositories (${pct(ratio)}) ${label}.`, { matching, total: sample.length, ratio });
}

function enterpriseProbe(evidence, key, fn, label) {
  if (!evidence.enterprise) return result('unknown', `Enterprise-level ${label} requires running with --enterprise.`);
  const p = evidence.enterprise[key];
  if (!p?.ok) return result('unknown', `Could not read ${label}: ${p?.error || 'not collected'}.`);
  return fn(p.data);
}

function targetsDefaultBranch(rs) {
  const include = rs.conditions?.ref_name?.include || [];
  return rs.target === 'branch' && include.some((r) => r === '~DEFAULT_BRANCH' || r === '~ALL');
}

function rulesetStatus(rulesets, ruleTypes, filter = () => true) {
  const relevant = rulesets.filter((rs) => filter(rs) && rs.rules.some((t) => ruleTypes.includes(t)));
  if (relevant.some((rs) => rs.enforcement === 'active')) return { status: 'pass' };
  if (relevant.some((rs) => rs.enforcement === 'evaluate')) return { status: 'partial', note: 'evaluate mode only' };
  return { status: 'fail', note: 'no matching ruleset' };
}

export const checks = {
  'GOV-01': (ev) => {
    if (!ev.enterprise) return result('unknown', 'Identity provider configuration requires running with --enterprise.');
    const { saml, oidc } = ev.enterprise;
    if (saml?.ok && saml.data) return result('pass', 'SAML single sign-on is configured for the enterprise.');
    if (oidc?.ok && oidc.data) return result('pass', 'OIDC (Enterprise Managed Users) identity provider is configured.');
    if (saml?.ok) return result('fail', 'No enterprise SAML or OIDC identity provider is configured.');
    return result('unknown', `Could not read identity provider configuration: ${saml?.error || oidc?.error}.`);
  },
  'GOV-02': (ev) => {
    const e = ev.enterprise;
    if (e?.twoFactor?.ok && e.twoFactor.data === 'ENABLED') return result('pass', 'The enterprise requires two-factor authentication for all organizations.');
    if (e?.oidc?.ok && e.oidc.data) return result('pass', 'Authentication (including MFA) is delegated to the OIDC identity provider.');
    return perOrg(ev, 'settings', (s) => (s.two_factor_requirement_enabled == null ? { status: 'unknown', note: 'requires org owner' } : { status: s.two_factor_requirement_enabled ? 'pass' : 'fail' }), 'the two-factor authentication requirement');
  },
  'GOV-03': (ev) =>
    enterpriseProbe(ev, 'auditLogStreams', (streams) => {
      const enabled = streams.filter((s) => s.enabled);
      return enabled.length ? result('pass', `Audit log streaming is enabled (${enabled.map((s) => s.type).join(', ')}).`) : result('fail', 'No enabled audit log stream is configured.');
    }, 'audit log streaming'),
  'GOV-04': (ev) => enterpriseProbe(ev, 'ipAllowList', (v) => (v === 'ENABLED' ? result('pass', 'The enterprise IP allow list is enabled.') : result('fail', 'The enterprise IP allow list is not enabled.')), 'the IP allow list setting'),
  'GOV-05': (ev) =>
    perOrg(ev, 'settings', (s) => {
      const p = s.default_repository_permission;
      if (!p) return { status: 'unknown', note: 'requires org owner' };
      if (p === 'none' || p === 'read') return { status: 'pass' };
      return { status: p === 'write' ? 'partial' : 'fail', note: `base permission '${p}'` };
    }, 'a least-privilege base repository permission'),
  'GOV-06': (ev) =>
    perOrg(ev, 'settings', (s) => {
      const v = s.members_can_create_public_repositories;
      if (v == null) return { status: 'unknown', note: 'requires org owner' };
      return v ? { status: 'fail', note: 'members can create public repos' } : { status: 'pass' };
    }, 'the public repository creation restriction'),
  'GOV-07': (ev) => perOrg(ev, 'rulesets', (rs) => rulesetStatus(rs, ['pull_request'], targetsDefaultBranch), 'default-branch pull request rulesets'),
  'GOV-08': (ev) => perOrg(ev, 'rulesets', (rs) => rulesetStatus(rs, ['required_status_checks', 'workflows'], (r) => r.target === 'branch'), 'required status check rulesets'),
  'GOV-09': (ev) => perOrg(ev, 'customProperties', (props) => (props.length ? { status: 'pass' } : { status: 'fail', note: 'no custom properties' }), 'custom property definitions'),
  'GOV-10': (ev) =>
    perOrg(ev, 'owners', (n) => {
      if (n <= 5) return { status: 'pass' };
      return { status: n <= 10 ? 'partial' : 'fail', note: `${n} owners` };
    }, 'an owner count of five or fewer'),
  'SEC-01': (ev) => repoCoverage(ev, (r) => r.security_and_analysis?.secret_scanning?.status === 'enabled', { label: 'have secret scanning enabled', requireSecurity: true }),
  'SEC-02': (ev) => repoCoverage(ev, (r) => r.security_and_analysis?.secret_scanning_push_protection?.status === 'enabled', { label: 'have push protection enabled', requireSecurity: true }),
  'SEC-03': (ev) => repoCoverage(ev, (r) => r.security_and_analysis?.dependabot_security_updates?.status === 'enabled', { label: 'have Dependabot security updates enabled', requireSecurity: true }),
  'SEC-04': (ev) =>
    perOrg(ev, 'securityConfigurations', (configs, _name, org) => {
      const withCodeScanning = configs.filter((c) => c.code_scanning_default_setup === 'enabled');
      if (!withCodeScanning.length) return { status: 'fail', note: 'no configuration enables code scanning' };
      const defaults = org.securityConfigurationDefaults?.ok ? org.securityConfigurationDefaults.data : [];
      const isDefault = defaults.some((d) => d.default_for_new_repos !== 'none' && withCodeScanning.some((c) => c.id === d.configuration_id));
      return isDefault ? { status: 'pass' } : { status: 'partial', note: 'code scanning configuration is not a default' };
    }, 'code scanning in a code security configuration'),
  'SEC-05': (ev) =>
    perOrg(ev, 'securityConfigurationDefaults', (defaults) => {
      const scopes = defaults.map((d) => d.default_for_new_repos).filter((s) => s && s !== 'none');
      if (scopes.includes('all')) return { status: 'pass' };
      if (scopes.length) return { status: 'partial', note: `default only for ${scopes.join('/')}` };
      return { status: 'fail', note: 'no default configuration' };
    }, 'a default code security configuration for new repositories'),
  'SEC-06': (ev) =>
    perOrg(ev, 'dependabotCriticalHigh', ({ count, truncated }, _name, org) => {
      const repoCount = org.repos?.ok ? org.repos.data.items.filter((r) => !r.archived).length : null;
      const label = `${count}${truncated ? '+' : ''} open critical/high`;
      if (count === 0) return { status: 'pass' };
      if (repoCount == null) return { status: count < 50 ? 'partial' : 'fail', note: label };
      const ratio = count / Math.max(1, repoCount);
      return { status: ratio <= 0.1 ? 'pass' : ratio <= 1 ? 'partial' : 'fail', note: label };
    }, 'a managed critical/high Dependabot alert backlog'),
  'SEC-07': (ev) =>
    perOrg(ev, 'secretScanningOpen', ({ count, truncated }) => {
      if (count === 0) return { status: 'pass' };
      return { status: count <= 5 ? 'partial' : 'fail', note: `${count}${truncated ? '+' : ''} open secret alerts` };
    }, 'zero open secret scanning alerts'),
  'SEC-08': (ev) =>
    perOrg(ev, 'actionsPermissions', (p) => {
      if (p.enabled_repositories === 'none') return { status: 'not_applicable', note: 'Actions disabled' };
      if (p.allowed_actions === 'all') return { status: 'fail', note: 'all actions allowed' };
      return { status: 'pass' };
    }, 'restricted allowed actions'),
  'SEC-09': (ev) =>
    perOrg(ev, 'workflowPermissions', (p) => {
      if (p.default_workflow_permissions === 'write') return { status: 'fail', note: 'write by default' };
      if (p.can_approve_pull_request_reviews) return { status: 'partial', note: 'Actions can approve PRs' };
      return { status: 'pass' };
    }, 'read-only default workflow permissions'),
  'SEC-10': (ev) => perOrg(ev, 'communityFiles', (f) => (f.securityPolicy ? { status: 'pass' } : { status: 'fail', note: 'no .github/SECURITY.md' }), 'a default security policy'),
  'ARC-01': (ev) =>
    perOrg(ev, 'selfHostedRunners', (count, _name, org) => {
      if (count === 0) return { status: 'not_applicable', note: 'no self-hosted runners' };
      if (!org.runnerGroups?.ok) return { status: 'unknown', note: 'runner groups unavailable' };
      const groups = org.runnerGroups.data;
      if (groups.some((g) => g.allows_public_repositories)) return { status: 'fail', note: 'runner group allows public repos' };
      if (groups.every((g) => g.visibility === 'all')) return { status: 'partial', note: 'runner groups open to all repos' };
      return { status: 'pass' };
    }, 'scoped self-hosted runner groups'),
  'ARC-02': (ev) => {
    const cutoff = Date.now() - STALE_DAYS * 86400000;
    return repoCoverage(ev, (repo) => !repo.pushed_at || Date.parse(repo.pushed_at) >= cutoff, { label: `were pushed to within ${STALE_DAYS} days (others should be archived)`, pass: 0.9, partial: 0.75 });
  },
  'COL-01': (ev) => sampleCoverage(ev, 'codeowners', (has) => has, { label: 'have a CODEOWNERS file', pass: 0.8, partial: 0.4 }),
  'COL-02': (ev) => repoCoverage(ev, (r) => r.description.trim().length > 0, { label: 'have a description', pass: 0.8, partial: 0.5 }),
  'COL-03': (ev) => perOrg(ev, 'communityFiles', (f) => (f.contributing ? { status: 'pass' } : { status: 'fail', note: 'no .github/CONTRIBUTING.md' }), 'default contributing guidelines'),
  'PRD-01': (ev) => sampleCoverage(ev, 'workflows', (n) => n > 0, { label: 'have GitHub Actions workflows', pass: 0.7, partial: 0.4 }),
  'PRD-02': (ev) => {
    let total = 0;
    let active = 0;
    let assessed = 0;
    const errors = [];
    for (const [name, org] of orgEntries(ev)) {
      if (org.copilot?.ok) {
        assessed++;
        total += org.copilot.data.total;
        active += org.copilot.data.active;
      } else errors.push(`${name}: ${org.copilot?.error || 'not collected'}`);
    }
    if (!assessed) return result('unknown', `Could not read Copilot seat data: ${errors[0] || 'no organizations'}.`);
    if (!total) return result('fail', 'No Copilot seats are assigned in the assessed organizations.', { total, active });
    const ratio = active / total;
    return result(coverage(ratio, { pass: 0.7, partial: 0.4 }), `${active} of ${total} assigned Copilot seats (${pct(ratio)}) were active this billing cycle.`, { total, active, ratio });
  },
};
