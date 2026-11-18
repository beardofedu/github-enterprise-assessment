import { GitHubClient } from './github-client.js';

export const COLLECTOR_VERSION = 1;

/** Runs an API call and records success or failure without throwing, so one denied endpoint never aborts the run. */
export async function probe(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status ?? null };
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

const enterpriseQuery = (field) => `query($slug: String!) { enterprise(slug: $slug) { ownerInfo { ${field} } } }`;

async function enterpriseField(client, slug, field, pick) {
  return probe(async () => {
    const data = await client.graphql(enterpriseQuery(field), { slug });
    if (!data.enterprise) throw new Error(`Enterprise '${slug}' not found or not accessible`);
    if (!data.enterprise.ownerInfo) throw new Error('Enterprise owner information is not accessible (enterprise owner required)');
    return pick(data.enterprise.ownerInfo);
  });
}

async function listEnterpriseOrgs(client, slug) {
  const logins = [];
  let after = null;
  do {
    const data = await client.graphql(
      `query($slug: String!, $after: String) { enterprise(slug: $slug) { organizations(first: 100, after: $after) { nodes { login } pageInfo { hasNextPage endCursor } } } }`,
      { slug, after },
    );
    if (!data.enterprise) throw new Error(`Enterprise '${slug}' not found or not accessible`);
    const conn = data.enterprise.organizations;
    logins.push(...conn.nodes.map((n) => n.login));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return logins;
}

export async function collectEnterprise(client, slug) {
  const [saml, oidc, twoFactor, ipAllowList, auditLogStreams] = await Promise.all([
    enterpriseField(client, slug, 'samlIdentityProvider { id }', (o) => Boolean(o.samlIdentityProvider)),
    enterpriseField(client, slug, 'oidcProvider { id }', (o) => Boolean(o.oidcProvider)),
    enterpriseField(client, slug, 'twoFactorRequiredSetting', (o) => o.twoFactorRequiredSetting),
    enterpriseField(client, slug, 'ipAllowListEnabledSetting', (o) => o.ipAllowListEnabledSetting),
    probe(async () => {
      const streams = await client.get(`/enterprises/${encodeURIComponent(slug)}/audit-log/streams`);
      return (streams || []).map((s) => ({ type: s.stream_type, enabled: s.enabled !== false }));
    }),
  ]);
  return { slug, saml, oidc, twoFactor, ipAllowList, auditLogStreams };
}

function slimRepo(r) {
  return {
    name: r.name,
    visibility: r.visibility,
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
    pushed_at: r.pushed_at,
    description: r.description || '',
    security_and_analysis: r.security_and_analysis || null,
  };
}

export async function collectOrg(client, org, { sampleSize = 25, maxRepos = 1000, concurrency = 4 } = {}) {
  const o = encodeURIComponent(org);
  const settings = probe(async () => {
    const s = await client.get(`/orgs/${o}`);
    return {
      two_factor_requirement_enabled: s.two_factor_requirement_enabled ?? null,
      default_repository_permission: s.default_repository_permission ?? null,
      members_can_create_public_repositories: s.members_can_create_public_repositories ?? null,
      plan: s.plan?.name ?? null,
    };
  });
  const rulesets = probe(async () => {
    const { items } = await client.paginate(`/orgs/${o}/rulesets?per_page=100`, { max: 50 });
    return mapLimit(items, concurrency, async (rs) => {
      const d = await client.get(`/orgs/${o}/rulesets/${rs.id}`);
      return { name: d.name, target: d.target, enforcement: d.enforcement, conditions: d.conditions || {}, rules: (d.rules || []).map((r) => r.type) };
    });
  });
  const customProperties = probe(async () => (await client.get(`/orgs/${o}/properties/schema`)).map((p) => p.property_name));
  const owners = probe(async () => (await client.paginate(`/orgs/${o}/members?role=admin&per_page=100`, { max: 500 })).items.length);
  const actionsPermissions = probe(() => client.get(`/orgs/${o}/actions/permissions`));
  const workflowPermissions = probe(() => client.get(`/orgs/${o}/actions/permissions/workflow`));
  const runnerGroups = probe(async () => {
    const data = await client.get(`/orgs/${o}/actions/runner-groups?per_page=100`);
    return (data.runner_groups || []).map((g) => ({ name: g.name, visibility: g.visibility, allows_public_repositories: Boolean(g.allows_public_repositories) }));
  });
  const selfHostedRunners = probe(async () => (await client.get(`/orgs/${o}/actions/runners?per_page=1`)).total_count ?? 0);
  const securityConfigurations = probe(async () =>
    (await client.get(`/orgs/${o}/code-security/configurations?per_page=100`)).map((c) => ({
      id: c.id,
      name: c.name,
      secret_scanning: c.secret_scanning,
      secret_scanning_push_protection: c.secret_scanning_push_protection,
      dependabot_alerts: c.dependabot_alerts,
      dependabot_security_updates: c.dependabot_security_updates,
      code_scanning_default_setup: c.code_scanning_default_setup,
    })),
  );
  const securityConfigurationDefaults = probe(async () =>
    (await client.get(`/orgs/${o}/code-security/configurations/defaults`)).map((d) => ({ default_for_new_repos: d.default_for_new_repos, configuration_id: d.configuration?.id ?? null })),
  );
  const dependabotCriticalHigh = probe(async () => {
    const { items, truncated } = await client.paginate(`/orgs/${o}/dependabot/alerts?state=open&severity=critical,high&per_page=100`, { max: 1000 });
    return { count: items.length, truncated };
  });
  const secretScanningOpen = probe(async () => {
    const { items, truncated } = await client.paginate(`/orgs/${o}/secret-scanning/alerts?state=open&per_page=100`, { max: 1000 });
    return { count: items.length, truncated };
  });
  const communityFiles = probe(async () => {
    const exists = async (path) => {
      try {
        await client.get(`/repos/${o}/.github/contents/${path}`);
        return true;
      } catch (err) {
        if (err.status === 404) return false;
        throw err;
      }
    };
    const [security, contributing] = await Promise.all([exists('SECURITY.md'), exists('CONTRIBUTING.md')]);
    return { securityPolicy: security, contributing };
  });
  const copilot = probe(async () => {
    const b = await client.get(`/orgs/${o}/copilot/billing`);
    return { total: b.seat_breakdown?.total ?? 0, active: b.seat_breakdown?.active_this_cycle ?? 0 };
  });
  const repos = probe(async () => {
    const { items, truncated } = await client.paginate(`/orgs/${o}/repos?type=all&sort=pushed&per_page=100`, { max: maxRepos });
    return { items: items.map(slimRepo), truncated };
  });

  const result = {
    settings: await settings,
    rulesets: await rulesets,
    customProperties: await customProperties,
    owners: await owners,
    actionsPermissions: await actionsPermissions,
    workflowPermissions: await workflowPermissions,
    runnerGroups: await runnerGroups,
    selfHostedRunners: await selfHostedRunners,
    securityConfigurations: await securityConfigurations,
    securityConfigurationDefaults: await securityConfigurationDefaults,
    dependabotCriticalHigh: await dependabotCriticalHigh,
    secretScanningOpen: await secretScanningOpen,
    communityFiles: await communityFiles,
    copilot: await copilot,
    repos: await repos,
    repoSample: { ok: false, error: 'Repository list unavailable' },
  };

  if (result.repos.ok) {
    const active = result.repos.data.items.filter((r) => !r.archived && !r.fork).slice(0, sampleSize);
    result.repoSample = await probe(async () =>
      mapLimit(active, concurrency, async (r) => {
        const rp = `/repos/${o}/${encodeURIComponent(r.name)}`;
        const codeowners = await probe(async () => {
          try {
            await client.get(`${rp}/codeowners/errors`);
            return true;
          } catch (err) {
            if (err.status === 404) return false;
            throw err;
          }
        });
        const workflows = await probe(async () => (await client.get(`${rp}/actions/workflows?per_page=1`)).total_count ?? 0);
        return { name: r.name, codeowners, workflows };
      }),
    );
  }
  return result;
}

/** Raised when an enterprise slug is given but its organizations cannot be listed with the current token. */
export class EnterpriseUnavailableError extends Error {
  constructor(enterprise, cause) {
    super(`Enterprise '${enterprise}' is not available to the authenticated token: ${cause}`);
    this.name = 'EnterpriseUnavailableError';
    this.enterprise = enterprise;
    this.detail = cause;
  }
}

export async function collect({ token, apiUrl, enterprise, orgs, tokenOrgFallback = false, sampleSize = 25, maxRepos = 1000, log = () => {}, fetchImpl } = {}) {
  const client = new GitHubClient({ token, apiUrl, fetchImpl });
  let orgList = orgs?.length ? orgs : null;
  let orgDiscovery = { ok: true, source: 'cli' };

  if (!orgList && enterprise) {
    log(`Discovering organizations in enterprise '${enterprise}'...`);
    const found = await probe(() => listEnterpriseOrgs(client, enterprise));
    if (found.ok) {
      orgList = found.data;
      orgDiscovery = { ok: true, source: 'enterprise' };
    } else if (!tokenOrgFallback) {
      throw new EnterpriseUnavailableError(enterprise, found.error);
    } else {
      orgDiscovery = { ok: false, source: 'enterprise', error: found.error };
    }
  }
  if (!orgList) {
    log('Falling back to organizations visible to the token...');
    const mine = await probe(async () => (await client.paginate('/user/orgs?per_page=100', { max: 1000 })).items.map((x) => x.login));
    orgList = mine.ok ? mine.data : [];
    if (!orgDiscovery.error) orgDiscovery = { ok: mine.ok, source: 'user', error: mine.error };
  }

  const enterpriseEvidence = enterprise ? (log('Collecting enterprise settings...'), await collectEnterprise(client, enterprise)) : null;

  const orgEvidence = {};
  for (const org of orgList) {
    log(`Collecting organization '${org}'...`);
    orgEvidence[org] = await collectOrg(client, org, { sampleSize, maxRepos });
  }

  return {
    meta: {
      collectorVersion: COLLECTOR_VERSION,
      generatedAt: new Date().toISOString(),
      apiUrl: client.apiUrl,
      enterprise: enterprise || null,
      organizations: orgList,
      orgDiscovery,
      sampleSize,
      maxRepos,
      requestCount: client.requestCount,
    },
    enterprise: enterpriseEvidence,
    orgs: orgEvidence,
  };
}
