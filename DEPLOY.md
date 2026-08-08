# ELD AI: Read Together — deploy guide

Two pieces. The site works with or without the backend; the backend only makes the
scaffolding generator call Claude for real instead of showing cached output.

```
index.html          → Vercel (static, single file, no build step)
backend/            → Hostinger VPS (Bun + Hono, holds your API key)
```

---

## 1. Edit four placeholders first

Search `index.html` for each of these and replace:

| Placeholder | Where it appears |
|---|---|
| `YOUR NAME` | `<meta author>`, hero byline, footer |
| `YOUR.EMAIL@DOMAIN.COM` | contact button, footer |
| `CREDENTIAL ONE` / `TWO` / `THREE` | hero byline — degrees, years teaching |
| `CREDENTIAL SUMMARY` | contact section paragraph — rewrite in your own voice |

There's also a `Source on GitHub` button with `href="#"`. Either point it at a repo or
delete the link. A dead button on a portfolio site is worse than no button.

**Why these are placeholders:** in the first pass I filled in a name, email, and
credentials that I had no source for — I never actually received the PDF you
referenced. Nothing in this file should claim anything about you that you didn't write.

---

## 2. Deploy the frontend

Vercel, no configuration:

```bash
# option A — drag index.html onto vercel.com/new
# option B — repo with index.html at the root
vercel --prod
```

No `vercel.json`, no build command, no framework preset. It's one file.

At this point everything works. The scaffolding generator falls back to cached output
and labels itself honestly as cached. Ship this first, then add the backend.

---

## 3. Deploy the backend (Hostinger)

**This needs a VPS plan.** Hostinger's shared web hosting can't run a persistent Bun
process. If you're on shared hosting, either upgrade to a VPS or skip this section —
the site is fully functional without it.

```bash
# on the VPS
curl -fsSL https://bun.sh/install | bash
git clone <your-repo> && cd backend
bun install
cp .env.example .env    # then fill in .env
bun run start           # smoke test on :8787
```

`.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
FRONTEND_URL=https://your-project.vercel.app
ANTHROPIC_MODEL=claude-sonnet-5
GLOBAL_PER_DAY=250
PER_IP_PER_HOUR=6
```

**Verify the model string in your Anthropic console before going live.** I can't see
which models your account has access to, and a wrong string fails at request time, not
at startup. `claude-haiku-4-5-20251001` is the cheaper option if this gets traffic.

Keep it running with systemd:

```ini
# /etc/systemd/system/eld-api.service
[Unit]
Description=ELD AI demo API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/backend
EnvironmentFile=/var/www/backend/.env
ExecStart=/root/.bun/bin/bun run server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now eld-api
systemctl status eld-api
```

Put it behind TLS — Caddy is two lines:

```
api.yourdomain.com {
  reverse_proxy localhost:8787
}
```

Then set the one line at the bottom of `index.html`:

```js
window.ELD_API_BASE = "https://api.yourdomain.com";
```

Verify: `curl https://api.yourdomain.com/health` should return your model, daily usage,
and caps.

---

## 4. Spend protection, since this is your key on a public URL

Enforced in `server.ts`, not in a dashboard alert:

- **6 generations per IP per hour** (`PER_IP_PER_HOUR`)
- **250 generations per day, globally** (`GLOBAL_PER_DAY`) — hard stop, resets at UTC midnight
- **`max_tokens` capped at 2000** (`MAX_TOKENS`)
- **Topic field capped at 80 characters** and screened for email, phone, and ID patterns
- **Every limit failure returns cached output**, so a rate-limited visitor still sees a
  complete demo rather than an error

Worst case at the daily cap is bounded and small. Set a billing alert anyway.

The rate limiter is in-memory, which is correct for one instance and wrong the moment
you run two. If you scale it, move the counters to Redis — noted here so it's a known
limitation rather than a surprise.

---

## 5. What's real and what isn't

Be able to answer this in an interview, because someone will ask.

| Element | What it actually is |
|---|---|
| Scaffolding generator | Real Claude API call, real prompt, live output |
| Payload disclosure panel | The actual request body, rendered from the same object that gets sent |
| Oral reading scorer | Real deterministic algorithm — alignment + phonological transfer rules — running in the browser. No model call. |
| Pre-built lesson examples | Written by hand, labeled as pre-built |
| Family view Spanish | Authored, not machine-translated at runtime |
| Pilot results | None. There are none, and the page says so. |

---

## 6. Known gaps, in priority order

1. **No ASR.** The scorer classifies a transcript. Nothing produces that transcript yet.
   This is the single biggest gap between the demo and a product, and the privacy
   analysis on the page is the reason it hasn't been rushed.
2. **In-memory rate limiting** breaks on a second instance.
3. **No persistence.** Nothing is saved — generated plans vanish on reload. Fine for a
   demo, and worth saying out loud so it doesn't read as an oversight.
4. **Transfer rules are orthographic, not phonemic.** They operate on spelling as a
   proxy for sound. A real implementation needs a phoneme-level representation, which
   changes the rule set substantially.
5. **Rules are Spanish-weighted.** Reasonable given ~75% of U.S. ELs are Spanish-speaking,
   but it is a limitation, not a design principle.
