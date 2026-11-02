# Token Cost Guard — local usage reports and focused QA

[Services](https://leesheep-ai.github.io/token-cost-guard/) · [Free demo](https://leesheep-ai.github.io/token-cost-guard/demo/) · [Executed QA sample](https://leesheep-ai.github.io/token-cost-guard/qa/)

Import CSV or JSON usage in your browser. Edit prices to match your own invoice. Unpriced models produce an incomplete estimate and a null total, not a zero-dollar claim. Negative or malformed token counts are rejected. Files stay in the tab; prices may be saved in local storage.

Custom import adapters start at $79 per agreed format. A $99 QA pilot covers up to five screens and one primary workflow, Chromium desktop/mobile viewports, a reproducible report, scripts and one retest. These are proposed service prices, not confirmed sales. Scope, timing and a mutually supported payment method must be agreed before work.

Use [a GitHub issue](https://github.com/leesheep-ai/token-cost-guard/issues/new) for a brief inquiry. Never include private logs, API keys or account credentials in public issues.

The sample is AI-assisted work on our own project with synthetic data, not a client engagement. Fifteen browser checks passed after fixes; two passed on the archived original. The report contains scripts, JSON results, screenshots and limits.

## Run the checks

From `qa/`, run `npm ci --ignore-scripts` and `npx playwright install chromium`. Set `QA_SITE_ROOT` to the repository root, then run `node verify.mjs after`. The report includes PowerShell commands for replaying the archived baseline, which intentionally exits with failures.
