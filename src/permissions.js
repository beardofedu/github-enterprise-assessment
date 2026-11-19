// Maps access-denied API failures in a finding to the classic OAuth scopes the gh CLI token needs.
// Scope requirements follow the "OAuth app tokens and personal access tokens (classic) need..." notes in the REST API docs.
const ENDPOINT_SCOPES = [
  [/^\/enterprises\/[^/]+\/audit-log/, ['read:audit_log']],
  [/^\/enterprises\//, ['read:enterprise']],
  [/^\/orgs\/[^/]+\/actions\//, ['admin:org']],
  [/^\/orgs\/[^/]+\/copilot\//, ['read:org']],
  [/^\/orgs\/[^/]+\/(dependabot|secret-scanning|code-scanning)\//, ['security_events']],
  [/^\/repos\//, ['repo']],
  [/^\/orgs\/[^/]+\/code-security\/configurations\/defaults$/, ['write:org']],
  [/^\/(orgs|user)\//, ['read:org']],
];

const DENIED = /GET (\/\S+) -> (401|403)\b/g;
const OWNER_ROLE = /must be an? (org(anization)? )?(admin|owner)|must be an administrator/i;
const REPOSITORY_ADMIN_ROLE = /admin access to repositories|repository administrator|repository admin/i;
const SECURITY_MANAGER_ROLE = /security manager/i;

export function hostForApiUrl(apiUrl) {
  if (!apiUrl || apiUrl === 'https://api.github.com') return 'github.com';
  const url = new URL(apiUrl);
  return url.hostname === 'api.github.com' || /^api\..+\.ghe\.com$/.test(url.hostname)
    ? url.hostname.slice(4)
    : url.hostname;
}

const refreshCommand = (scopes, apiUrl) => {
  const host = hostForApiUrl(apiUrl);
  const quotedHost = /^[a-z0-9.-]+$/i.test(host) ? host : "'" + host.replace(/'/g, "'\\''") + "'";
  return `gh auth refresh -h ${quotedHost} -s ${scopes.join(',')}`;
};

function scopesForPath(path) {
  const clean = path.split('?')[0];
  return ENDPOINT_SCOPES.find(([pattern]) => pattern.test(clean))?.[1] || [];
}

/** Returns { scopes, command, requiresOwner } when a finding reports a scope-related access failure, otherwise null. */
export function accessRemediation(finding, apiUrl) {
  if (!finding || /API rate limit exceeded|secondary rate limit|IP allow[ -]?list/i.test(finding)) return null;
  const scopes = new Set();
  for (const [, path] of finding.matchAll(DENIED)) scopesForPath(path).forEach((s) => scopes.add(s));
  // GraphQL reports missing scopes explicitly, e.g. "requires one of the following scopes: ['read:enterprise']".
  const graphql = finding.match(/following scopes: \[([^\]]+)\]/);
  if (graphql) graphql[1].match(/[a-z_:]+/g)?.forEach((s) => scopes.add(s));
  if (/repository security settings were not returned/.test(finding)) scopes.add('repo');
  if (!scopes.size) return null;
  const list = [...scopes].sort();
  return {
    scopes: list,
    command: refreshCommand(list, apiUrl),
    requiresOwner: OWNER_ROLE.test(finding),
    requiresRepositoryAdmin: REPOSITORY_ADMIN_ROLE.test(finding),
    requiresSecurityManager: SECURITY_MANAGER_ROLE.test(finding),
  };
}

/** Combines remediation for several gaps into a single gh auth refresh command. */
export function combinedAccessRemediation(gaps, apiUrl) {
  const scopes = new Set();
  let requiresOwner = false;
  let requiresRepositoryAdmin = false;
  let requiresSecurityManager = false;
  for (const g of gaps) {
    if (!g.access) continue;
    g.access.scopes.forEach((s) => scopes.add(s));
    requiresOwner ||= g.access.requiresOwner;
    requiresRepositoryAdmin ||= g.access.requiresRepositoryAdmin;
    requiresSecurityManager ||= g.access.requiresSecurityManager;
  }
  if (!scopes.size) return null;
  const list = [...scopes].sort();
  return { scopes: list, command: refreshCommand(list, apiUrl), requiresOwner, requiresRepositoryAdmin, requiresSecurityManager };
}
