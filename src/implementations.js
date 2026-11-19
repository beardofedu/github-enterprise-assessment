const SETTINGS = {
  'GOV-05': {
    field: 'default_repository_permission',
    desired: 'read',
    isKnown: (value) => ['none', 'read', 'write', 'admin'].includes(value),
    isCompliant: (value) => value === 'none' || value === 'read',
  },
  'GOV-06': {
    field: 'members_can_create_public_repositories',
    desired: false,
    isKnown: (value) => typeof value === 'boolean',
    isCompliant: (value) => value === false,
  },
};

export async function implementOrganizationSetting({ controlId, organization, token, apiUrl, fetchImpl = globalThis.fetch }) {
  const setting = SETTINGS[controlId];
  if (!setting) throw new Error('This control requires manual implementation.');
  if (typeof token !== 'string' || !token.trim() || token.length > 512) throw new Error('A separate implementation token is required.');

  const base = new URL(apiUrl || 'https://api.github.com');
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('The GitHub API URL must use HTTPS and cannot include credentials.');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  base.search = '';
  base.hash = '';
  const url = new URL(`orgs/${encodeURIComponent(organization)}`, base);
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-enterprise-assessment',
  };
  const request = async (method, body) => {
    const response = await fetchImpl(url, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} while applying the setting.`);
    return response.json();
  };

  const current = await request('GET');
  if (!setting.isKnown(current[setting.field])) throw new Error('GitHub did not return the current setting; no change was made.');
  if (setting.isCompliant(current[setting.field])) return { changed: false, message: `${organization} already has the recommended setting.` };

  const updated = await request('PATCH', { [setting.field]: setting.desired });
  if (!setting.isCompliant(updated[setting.field])) throw new Error('GitHub did not confirm the requested setting. Re-run the assessment to verify its state.');
  return { changed: true, message: `Updated ${controlId} for ${organization}. Re-run the assessment to verify the result.` };
}
