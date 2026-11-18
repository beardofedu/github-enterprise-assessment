# GitHub Enterprise Assessment

This repository includes two separate local assessment apps. The Python app and the Node.js app have independent rubrics, evidence formats, and data storage; their assessment files are not interchangeable. Choose the workflow below that matches the app you want to use.

## Python app: Primer dashboard and CLI

A local-first, read-only assessment tool for GitHub Enterprise Cloud. It combines a reusable Python scoring engine, command-line workflow, and localhost dashboard. The dashboard uses Primer CSS and semantic HTML; assessment data stays in a local data directory.

### Quick start

Requirements: Python 3.9+ and Node.js 20+/npm for the locally served Primer CSS and accessibility test dependencies.

```sh
npm ci
python3 -m assessment demo
python3 -m assessment serve
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The demo uses clearly labeled fictional data. It makes no GitHub requests. Press Ctrl-C to stop the server. The server refuses to bind to a non-loopback address.

The default data directory is `~/.local/share/gh-enterprise-assessment/` with owner-only permissions. Set `GH_ASSESSMENT_HOME` or pass `--data-dir` to use another directory. Assessment evidence and exported reports can include sensitive organizational metadata; protect and delete them according to your organization's policies.

### Collect a real enterprise

Only collect from an enterprise you are authorized to assess. The enterprise slug must be explicitly supplied; the tool never discovers or scans an account on its own. The first release supports GitHub Enterprise Cloud at `github.com` only; it does not apply Cloud assumptions to GitHub Enterprise Server.

```sh
# Set GH_TOKEN securely in this shell using your approved local secret manager.
python3 -m assessment collect --enterprise YOUR_ENTERPRISE_SLUG
```

The collector needs a token that can access the GraphQL Enterprise Accounts API and read the selected organizations' repository metadata. For the enterprise organization connection, GitHub documents the classic token `read:enterprise` scope; access to organization/repository endpoints is independently permission-checked. Enterprise-installed GitHub Apps do not automatically receive organization or repository access. Missing or denied access is reported as an explicit collection gap; it is never converted into a disabled setting or a passing score. Tokens are read only from the process environment and are never saved in snapshots or reports.

Collection is limited to the organization roster and repository metadata needed for secret-scanning configuration. It does not retrieve source code, issues, pull request bodies, secrets, or alert contents. GitHub API pagination is followed via Link headers; rate limits and permission failures stop or mark collection as partial. Rerun after fixing access or waiting for the rate-limit reset.

### Assess and export

The rubric includes all five Well-Architected pillars. Practice-based questions are deliberately manual: API settings do not prove review quality, alert response, audit monitoring, or recovery effectiveness.

```sh
python3 -m assessment attest --criterion GOV-01 --level 2 \
  --note "Reviewed the retention policy and a recent alert exercise with the platform owner."
python3 -m assessment report --format json --output assessment.json
python3 -m assessment report --format html --output assessment.html
```

Use levels 0 (confirmed missing), 1 (ad hoc), 2 (established), and 3 (managed), or `na` with an evidence-backed rationale. Empty notes are rejected. Unknown, inaccessible, incomplete, and not-applicable results are separate from a confirmed level 0. Only findings with evidence are included in score denominators. Every criterion carries its rubric guidance link, evidence requirement, remediation, and priority rationale.

The maturity scale is project-defined, not an official GitHub scoring scale, certification, or guarantee. Automated findings score configuration only; manual attestations are labeled and assigned medium confidence. Results should be validated with stakeholder interviews and operational evidence.

### Rubric sources

The framework's [getting-started checklist](https://learn.github.com/well-architected/overview/getting-started-checklist) names the five pillars and describes an environment review with stakeholder interviews, analysis, and recommendation review. This first rubric version is a deliberately bounded sample, not the complete official checklist:

- [Productivity](https://learn.github.com/well-architected/productivity/checklist): repeatable CI feedback.
- [Collaboration](https://learn.github.com/well-architected/collaboration/checklist): code-review practices and onboarding.
- [Application Security](https://learn.github.com/well-architected/application-security/checklist): secret scanning, push protection, and response practices.
- [Governance](https://learn.github.com/well-architected/governance/checklist): audit monitoring and effective branch policy.
- [Architecture](https://learn.github.com/well-architected/architecture/checklist): recovery exercises.

Rubric version `1.0.0` and snapshot schema version `1` are recorded with the local evidence. Review the current framework links before relying on findings.

### Primer and accessibility

The dashboard uses locally installed Primer CSS (`@primer/css`), Primer component classes and color tokens, responsive layouts, visible keyboard focus, a skip link, semantic headings/landmarks, labeled controls, status announcements, reduced-motion handling, and no color-only status encoding. `npm run test:a11y` runs axe against the main dashboard in light and dark themes and after saving an attestation; it also checks the first keyboard stop and a narrow 390px viewport. This automation is a useful guardrail, not a substitute for human review with keyboard-only interaction, browser zoom, VoiceOver/Safari, and NVDA/Chrome.

### Tests

```sh
python3 -m unittest discover -s tests -v
npm run test:a11y
```

The test suite covers deterministic scoring, status/coverage semantics, version checks, API pagination and errors, manual evidence persistence, report escaping, and automated accessibility checks. The browser test requires Playwright's Chromium browser. If it is not installed yet, run `npx playwright install chromium`.
## Node.js app: Well-Architected dashboard and CLI

A local dashboard and CLI for identifying improvement opportunities in a GitHub enterprise. It combines read-only GitHub API evidence with an assessor questionnaire and produces prioritized reports aligned with the [GitHub Well-Architected Framework](https://learn.github.com/well-architected).

This is an independently defined rubric and maturity model, not an official GitHub certification or a comprehensive security audit. Results are indicators for human review, not proof of compliance.

### Requirements

- Node.js 20 or later.
- For live collection, a GitHub token or an authenticated [GitHub CLI](https://cli.github.com/) session. The app uses `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.

The Node.js app itself needs no package installation. The Python dashboard's CSS and the accessibility tests require `npm ci`.

### Try the demo

```sh
npm run demo
```

Open the displayed local URL. The demo uses fictional evidence and saves questionnaire answers to `answers.demo.json`. Press Ctrl+C to stop the server.

### Assess an enterprise

```sh
gh auth login
node bin/gh-waf-assess.js run --enterprise YOUR_ENTERPRISE_SLUG
```

The command collects evidence into `evidence.json`, starts a dashboard on `http://127.0.0.1:4173`, and saves answers to `answers.json`. Complete the questionnaire to assess controls that cannot be determined from the API.

To collect and report separately:

```sh
node bin/gh-waf-assess.js collect --enterprise YOUR_ENTERPRISE_SLUG --out evidence.json
node bin/gh-waf-assess.js serve --evidence evidence.json
node bin/gh-waf-assess.js assess --evidence evidence.json --answers answers.json --format md --out reports/assessment.md
node bin/gh-waf-assess.js assess --evidence evidence.json --answers answers.json --format html --out reports/assessment.html
```

Reports can also be downloaded from the dashboard. Use `--format json` for machine-readable output, and `--fail-under N` to exit with code 2 when the overall score is below a threshold. See `node bin/gh-waf-assess.js --help` for all options.

### Access and coverage

Use an identity with access to the enterprise and its organizations. Enterprise-owner and organization-owner permissions may be needed for administrative settings; repository and security-alert visibility also depends on the identity's access. For a classic personal access token or `gh` OAuth token, scopes such as `read:enterprise`, `read:org`, `repo`, `security_events`, and `read:audit_log` may be needed depending on the checks and repositories. Enterprise audit-log streaming endpoints require a classic token with `read:audit_log`. Authorize the token for SAML SSO where required.

Start with the least access appropriate for your assessment. Limited access, unsupported API fields, and failed requests become coverage gaps rather than failures. Review the dashboard's coverage gaps and the discovery warning before interpreting scores. A fine-grained token or GitHub App installation token may cover a subset of endpoints; GitHub App authentication is not implemented by this tool.

By default the collector discovers organizations through the enterprise API. If discovery fails, it falls back to organizations visible to the authenticated user, which may not match the enterprise. Use `--orgs org-one,org-two` to specify scope explicitly. Repository inventory is capped at 1,000 per organization and deep inspection samples 25 active repositories by default; adjust these with `--max-repos` and `--sample`. Samples and truncated inventories are not comprehensive.

For GitHub Enterprise Server, supply `--api-url https://HOST/api/v3` and authenticate with a token for that host. API availability differs by version, so some checks may be unavailable.

### Rubric and scoring

The bundled rubric has 44 controls: 15 Governance, 13 Application Security, 6 Architecture, 5 Collaboration, and 5 Productivity. Controls use automated evidence or manual answers, with references and suggested remediation. List them with:

```sh
node bin/gh-waf-assess.js rubric
```

Pass, partial, and fail are scored as 1, 0.5, and 0, weighted by control importance. Unknown, unanswered, and not-applicable controls are excluded from scores; coverage shows the percentage of applicable controls that were scored. A high score with low coverage is not a complete assessment. The maturity labels are Initial (<40), Developing (40–59.9), Defined (60–74.9), Managed (75–89.9), and Optimized (90–100).

To customize controls or scoring, copy `rubric/well-architected.json` and pass `--rubric path/to/rubric.json`. New automated controls also require a matching check implementation in `src/checks.js`.

### Privacy

The dashboard binds to loopback and the collector only makes read-only GitHub API requests. Evidence, answers, and exported reports can contain sensitive enterprise configuration and assessor notes; keep them secure and do not commit them. Default output filenames are ignored by Git, but custom output paths may not be.

### Development

```sh
npm test
```
