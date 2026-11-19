import { readFileSync } from 'node:fs';
import { readPrimerCss } from './web-assets.js';

const TEMPLATE_URL = new URL('./web/index.html', import.meta.url);
const PRIMER_LINK = '<link rel="stylesheet" href="/primer.css">';
const STATUS_ICON = { pass: '✅', partial: '🟡', fail: '❌', unknown: '❔', unanswered: '📝', not_applicable: '➖' };
const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderJson(assessment) {
  return JSON.stringify(assessment, null, 2);
}

export function renderMarkdown(a) {
  const pillarName = (id) => a.pillars.find((p) => p.id === id)?.name || id;
  const lines = [];
  lines.push('# GitHub Well-Architected Enterprise Assessment', '');
  if (a.meta.enterprise) lines.push(`- **Enterprise:** ${a.meta.enterprise}`);
  lines.push(`- **Organizations:** ${a.meta.organizations.length ? a.meta.organizations.join(', ') : 'none'}`);
  if (a.meta.evidenceGeneratedAt) lines.push(`- **Evidence collected:** ${a.meta.evidenceGeneratedAt}`);
  lines.push(`- **Rubric:** [${a.meta.rubric.title} v${a.meta.rubric.version}](${a.meta.rubric.source})`, '');

  lines.push('## Summary', '');
  const o = a.overall;
  lines.push(`**Overall score: ${o.score ?? 'n/a'} / 100** — ${o.maturity ? `Level ${o.maturity.level} (${o.maturity.name})` : 'insufficient data'}. ${o.assessedControls} of ${o.applicableControls} applicable controls assessed (${o.coverage}% coverage).`, '');
  lines.push('| Pillar | Score | Maturity | Pass | Partial | Fail | Not assessed |', '|---|---|---|---|---|---|---|');
  for (const p of a.pillars) {
    const c = p.counts;
    lines.push(`| [${p.name}](${p.url}) | ${p.score ?? 'n/a'} | ${p.maturity?.name ?? 'n/a'} | ${c.pass || 0} | ${c.partial || 0} | ${c.fail || 0} | ${(c.unknown || 0) + (c.unanswered || 0)} |`);
  }
  lines.push('');

  lines.push('## Prioritized improvement areas', '');
  if (!a.improvements.length) lines.push('_No improvement areas identified among assessed controls._', '');
  a.improvements.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.id} — ${c.title}`, '');
    lines.push(`- **Pillar / area:** ${pillarName(c.pillar)} / ${c.area}`);
    lines.push(`- **Status:** ${STATUS_ICON[c.status]} ${c.status} · **Severity:** ${c.severity} · **Priority:** ${c.priority}`);
    lines.push(`- **Finding:** ${c.finding}`);
    lines.push(`- **Recommendation:** ${c.remediation}`);
    if (c.references?.length) lines.push(`- **Guidance:** ${c.references.map((r) => `<${r}>`).join(', ')}`);
    lines.push('');
  });

  if (a.coverageGaps.length) {
    lines.push('## Coverage gaps', '', 'These controls are excluded from scores until evidence or an assessor answer is provided.', '');
    lines.push('| Control | Pillar | Status | Reason |', '|---|---|---|---|');
    for (const g of a.coverageGaps) lines.push(`| ${g.id} ${cell(g.title)} | ${pillarName(g.pillar)} | ${g.status} | ${cell(g.question || g.finding)} |`);
    lines.push('');
    if (a.coverageAccess) {
      lines.push('To fill the permission-related gaps, add the missing scopes to the GitHub CLI token and re-run collection:', '', '```sh', a.coverageAccess.command, '```', '');
      if (a.coverageAccess.requiresRepositoryAdmin) lines.push('The authenticated account must also have repository administrator access.', '');
      if (a.coverageAccess.requiresOwner) lines.push('The authenticated account must also be an organization owner (or have the matching fine-grained permission).', '');
      if (a.coverageAccess.requiresSecurityManager) lines.push('The authenticated account must also have the security manager role.', '');
    }
  }

  lines.push('## All controls', '', '| Control | Pillar | Source | Status | Finding |', '|---|---|---|---|---|');
  for (const c of a.controls) lines.push(`| ${c.id} ${cell(c.title)} | ${pillarName(c.pillar)} | ${c.source} | ${STATUS_ICON[c.status]} ${c.status} | ${cell(c.finding)}${c.notes ? ` _Notes: ${cell(c.notes)}_` : ''} |`);
  lines.push('');
  return lines.join('\n');
}

/** Self-contained HTML report: the dashboard template with the assessment embedded (read-only). */
export function renderHtml(assessment, primerCss = readPrimerCss()) {
  const template = readFileSync(TEMPLATE_URL, 'utf8');
  if (!template.includes(PRIMER_LINK)) throw new Error('Dashboard template is missing its Primer stylesheet link.');
  const css = primerCss.replace(/<\/style/gi, '<\\/style');
  const json = JSON.stringify(assessment).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return template
    .replace('<script>', () => `<script>window.__ASSESSMENT__ = ${json};</script>\n<script>`)
    .replace(PRIMER_LINK, () => `<style>\n${css}\n</style>`);
}

export function render(assessment, format) {
  if (format === 'json') return renderJson(assessment);
  if (format === 'md' || format === 'markdown') return renderMarkdown(assessment);
  if (format === 'html') return renderHtml(assessment);
  throw new Error(`Unknown format '${format}' (use md, json, or html)`);
}
