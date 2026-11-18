#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../src/collector.js';
import { resolveToken } from '../src/github-client.js';
import { assess, loadRubric, DEFAULT_RUBRIC_PATH } from '../src/engine.js';
import { render } from '../src/report.js';
import { createServer, loadAnswers } from '../src/server.js';
import { readPrimerCss } from '../src/web-assets.js';

const DEMO_EVIDENCE = fileURLToPath(new URL('../examples/sample-evidence.json', import.meta.url));

const HELP = `gh-waf-assess — assess a GitHub Enterprise against the GitHub Well-Architected Framework

Usage:
  gh-waf-assess run      --enterprise <slug> [collect options] [serve options]
  gh-waf-assess collect  --enterprise <slug> [--orgs a,b] [--api-url URL] [--sample 25] [--max-repos 1000] [--out evidence.json]
  gh-waf-assess assess   --evidence evidence.json [--answers answers.json] [--format md|json|html] [--out FILE] [--fail-under N]
  gh-waf-assess serve    --evidence evidence.json [--answers answers.json] [--port 4173]
  gh-waf-assess serve    --demo
  gh-waf-assess rubric   [--rubric FILE]

Options:
  --enterprise   Enterprise slug (enables enterprise-level checks and org discovery)
  --orgs         Comma-separated organizations to assess (default: all orgs in the enterprise)
  --api-url      REST API base URL (default https://api.github.com; GHES: https://HOST/api/v3)
  --sample       Active repositories per org to deep-inspect for CODEOWNERS/workflows (default 25)
  --max-repos    Maximum repositories inventoried per org (default 1000)
  --evidence     Evidence file produced by \`collect\`
  --answers      Questionnaire answers file (default answers.json)
  --rubric       Custom rubric JSON (default: built-in Well-Architected rubric)
  --format       Report format for \`assess\`: md, json, or html (default md)
  --out          Output file (default: evidence.json for collect, stdout for assess)
  --fail-under   Exit with code 2 when the overall score is below N (useful in automation)
  --port         Dashboard port (default 4173; bound to 127.0.0.1 only)
  --demo         Serve the dashboard with bundled sample evidence

Authentication: uses GH_TOKEN, GITHUB_TOKEN, or \`gh auth token\`. All API calls are read-only.
`;

const options = {
  enterprise: { type: 'string' },
  orgs: { type: 'string' },
  'api-url': { type: 'string', default: process.env.GITHUB_API_URL || 'https://api.github.com' },
  sample: { type: 'string', default: '25' },
  'max-repos': { type: 'string', default: '1000' },
  evidence: { type: 'string' },
  answers: { type: 'string', default: 'answers.json' },
  rubric: { type: 'string', default: DEFAULT_RUBRIC_PATH },
  format: { type: 'string', default: 'md' },
  out: { type: 'string' },
  'fail-under': { type: 'string' },
  port: { type: 'string', default: '4173' },
  demo: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const log = (msg) => process.stderr.write(`${msg}\n`);
const fail = (msg) => {
  log(`Error: ${msg}`);
  process.exit(1);
};
const positiveInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeOut = (path, content) => {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, content);
};

async function runCollect(values) {
  const token = resolveToken();
  if (!token) fail('No GitHub token found. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`.');
  const orgs = values.orgs ? values.orgs.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!values.enterprise && !orgs) log('No --enterprise or --orgs given; assessing all organizations visible to the token.');
  const evidence = await collect({
    token,
    apiUrl: values['api-url'],
    enterprise: values.enterprise,
    orgs,
    sampleSize: positiveInt(values.sample, 'sample'),
    maxRepos: positiveInt(values['max-repos'], 'max-repos'),
    log,
  });
  const out = values.out || 'evidence.json';
  writeOut(out, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`Collected ${evidence.meta.organizations.length} organization(s) with ${evidence.meta.requestCount} API requests -> ${out}`);
  if (!evidence.meta.orgDiscovery.ok) log(`Warning: organization discovery failed: ${evidence.meta.orgDiscovery.error}`);
  return { evidence, path: out };
}

function serve(values, evidence) {
  const rubric = loadRubric(values.rubric);
  const port = positiveInt(values.port, 'port');
  const answersPath = values.answers;
  const server = createServer({ rubric, evidence, answersPath, port });
  server.listen(port, '127.0.0.1', () => {
    log(`Dashboard: http://127.0.0.1:${port}  (answers saved to ${answersPath}; Ctrl+C to stop)`);
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch (err) {
    fail(err.message);
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  switch (command) {
    case 'collect':
      await runCollect(values);
      break;
    case 'assess': {
      if (!values.evidence) fail('--evidence is required');
      const assessment = assess({ rubric: loadRubric(values.rubric), evidence: readJson(values.evidence), answers: loadAnswers(values.answers) });
      const output = render(assessment, values.format);
      if (values.out) {
        writeOut(values.out, output);
        log(`Wrote ${values.format} report to ${values.out}`);
      } else process.stdout.write(`${output}\n`);
      log(`Overall score: ${assessment.overall.score ?? 'n/a'} (${assessment.overall.maturity?.name ?? 'insufficient data'}), ${assessment.improvements.length} improvement areas, ${assessment.overall.coverage}% coverage`);
      if (values['fail-under'] != null && (assessment.overall.score ?? 0) < Number(values['fail-under'])) process.exit(2);
      break;
    }
    case 'serve': {
      const path = values.demo ? DEMO_EVIDENCE : values.evidence;
      if (!path) fail('--evidence is required (or use --demo)');
      if (values.demo && values.answers === options.answers.default) values.answers = 'answers.demo.json';
      serve(values, readJson(path));
      break;
    }
    case 'run': {
      readPrimerCss();
      const { evidence } = await runCollect(values);
      serve(values, evidence);
      break;
    }
    case 'rubric': {
      const rubric = loadRubric(values.rubric);
      for (const p of rubric.pillars) {
        process.stdout.write(`\n${p.name} (${p.url})\n`);
        for (const c of rubric.controls.filter((x) => x.pillar === p.id)) process.stdout.write(`  ${c.id}  [${c.type.padEnd(9)} w${c.weight}]  ${c.title}\n`);
      }
      break;
    }
    default:
      fail(`Unknown command '${command}'. Run with --help.`);
  }
}

main().catch((err) => fail(err.message));
