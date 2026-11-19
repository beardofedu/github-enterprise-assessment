# Accessibility

We aim to make the local dashboard and generated HTML reports usable by
people with diverse abilities and assistive technologies.

## Testing and supported environments

The automated accessibility checks run in Playwright's Chromium browser. They
use axe on dashboard views in light and dark themes, after questionnaire
interactions, and at a narrow viewport. The checks also cover keyboard
navigation, reflow, and report styling and contrast.

Run `npm run test:a11y` after installing the dependencies and Playwright's
Chromium browser, as described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

Automated checks cover representative scenarios, not every interaction or
accessibility barrier, and do not establish conformance. Browser and assistive
technology combinations have not been comprehensively tested. Manual review,
including keyboard-only use, browser zoom, VoiceOver with Safari, and NVDA with
Chrome, is encouraged.

## Report an accessibility barrier

Please [open a bug report](https://github.com/beardofedu/github-enterprise-assessment/issues/new/choose)
and describe the task, steps to reproduce, expected result, browser and
operating system, and any assistive technology involved. Use fictional or
sanitized examples; do not include sensitive enterprise data or credentials.
