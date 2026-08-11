# ReadTogether project case study - deployment

This repository has two deliberately separate surfaces:

- `/index.html` is the employer-facing static project case study.
- `/backend/` is an optional public demo API. The case study does not require it and defaults to clearly labeled cached output.

## Deploy the case study

Import this repository into Vercel as a static project:

- Framework preset: Other
- Root directory: repository root
- Build command: none
- Output directory: `.`

The production URL used by the page metadata is `https://readtogether.vercel.app/`.

## Evidence status

This is a pre-pilot local prototype and project case study. A private product-owner dry run has occurred, but there have been no educator or student research participants, pilots, classroom deployments, school partnerships, assessment-validity studies, or measured outcomes. Every future success measure is a proposed research gate, not a result.

## Optional demo API

The Bun/Hono API in `/backend/` can generate a lesson scaffold from an allow-listed instructional payload. Do not deploy it merely to make the portfolio appear more complete: the static case study works without it.

If it is deployed later, use a Bun-compatible host and set environment variables through the host dashboard:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `FRONTEND_URL`
- `GLOBAL_PER_DAY`
- `PER_IP_PER_HOUR`
- `MAX_TOKENS`

Never commit secret values. Verify CORS, rate limits, daily spend controls, the PII screen, and the `/health` route before connecting the page by setting `window.ELD_API_BASE` in `index.html`.

## Portfolio connection

The main portfolio is `https://matttracey.netlify.app/`. Its ReadTogether section should link here as the primary action and describe the verified local three-part workflow. A link to the broader authenticated SaaS prototype should remain secondary until that application passes its authorization, privacy, and deployment checks.
