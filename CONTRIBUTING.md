# Contributing

Contributions are welcome, including bug reports, accessibility feedback,
documentation improvements, and code changes. Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md) in project interactions.

## Before you start

- Use the [issue templates](https://github.com/beardofedu/github-enterprise-assessment/issues/new/choose)
  to report a bug or suggest an improvement. For a substantial change,
  consider opening an issue to discuss the approach first.
- Report suspected vulnerabilities privately as described in the
  [security policy](SECURITY.md), not in a public issue or pull request.
- Use fictional or sanitized data in issues and contributions. Enterprise
  evidence, assessment answers, reports, and credentials can be sensitive.

## Set up the project

Install Node.js 20 or later and npm, then run the following from the repository
root:

```sh
npm ci
```

Run the local dashboard with fictional demo evidence:

```sh
npm run demo
```

See the [README](README.md) for the CLI, configuration, and project overview.

## Check your changes

Run the automated tests:

```sh
npm test
```

For changes to the dashboard or HTML reports, also run the accessibility
checks:

```sh
npm run test:a11y
```

If Playwright's Chromium is not installed yet, run
`npx playwright install chromium` first. Automated checks do not replace
manual accessibility review; see the [accessibility statement](ACCESSIBILITY.md).

## Open a pull request

Describe the change and its motivation, link any related issue, and list the
checks you ran. Add or update tests and documentation when appropriate. Do not
include secrets or real enterprise assessment data.

Contributions are made available under the project's [MIT License](LICENSE).
