/**
 * ELD AI: Read Together — public demo API
 * Hono on Bun. Single purpose: generate WIDA-differentiated lesson scaffolding.
 *
 * Design constraints this file exists to enforce:
 *  1. The Anthropic key never reaches the browser.
 *  2. The outbound payload is an allow-list built field by field. There is no
 *     path by which a free-text field other than `topic` reaches the model,
 *     and `topic` is length-capped and pattern-screened.
 *  3. A public demo running on a personal API key needs a spend ceiling that
 *     is enforced in code, not in a dashboard alert.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(Bun.env.PORT ?? 8787);
const MODEL = Bun.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const MAX_TOKENS = Number(Bun.env.MAX_TOKENS ?? 2000);

// Comma-separated list. Set this to your Vercel domain in production.
const ORIGINS = (Bun.env.FRONTEND_URL ?? "http://localhost:5173")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

// Spend ceiling, enforced here rather than hoped for.
const PER_IP_PER_HOUR = Number(Bun.env.PER_IP_PER_HOUR ?? 6);
const GLOBAL_PER_DAY = Number(Bun.env.GLOBAL_PER_DAY ?? 250);

if (!Bun.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Refusing to start.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: Bun.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Rate limiting (in-memory; single instance by design)
// ---------------------------------------------------------------------------

const ipHits = new Map<string, number[]>();
let dayStamp = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStamp) {
    dayStamp = today;
    dayCount = 0;
  }
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

type Gate = { ok: true; remaining: number } | { ok: false; reason: string };

function gate(ip: string): Gate {
  rollDay();
  if (dayCount >= GLOBAL_PER_DAY) {
    return { ok: false, reason: "daily_cap" };
  }
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > hourAgo);
  if (hits.length >= PER_IP_PER_HOUR) {
    return { ok: false, reason: "ip_hourly" };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return { ok: true, remaining: PER_IP_PER_HOUR - hits.length };
}

// Keep the map from growing without bound.
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [ip, hits] of ipHits) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length === 0) ipHits.delete(ip);
    else ipHits.set(ip, live);
  }
}, 600_000);

// ---------------------------------------------------------------------------
// Input validation — the allow-list boundary
// ---------------------------------------------------------------------------

const SUBJECTS = ["ELD/ESL", "ELA", "Math", "Science", "Social Studies"] as const;
const GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
const KLUS = ["Narrate", "Inform", "Explain", "Argue"] as const;
const DURATIONS = [30, 45, 50, 60, 90] as const;

// Screens the one free-text field for things that should never be in a topic.
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "email address"],
  [/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, "phone number"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "government ID number"],
];

type Payload = {
  gradeLevel: string;
  subject: string;
  topic: string;
  widaLevels: number[];
  keyLanguageUse: string;
  duration: number;
};

function validate(body: any): { ok: true; payload: Payload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Malformed request body." };

  const gradeLevel = String(body.gradeLevel ?? "");
  if (!GRADES.includes(gradeLevel as any)) return { ok: false, error: "Grade level must be K through 12." };

  const subject = String(body.subject ?? "");
  if (!SUBJECTS.includes(subject as any)) return { ok: false, error: "Unrecognized subject area." };

  const keyLanguageUse = String(body.keyLanguageUse ?? "");
  if (!KLUS.includes(keyLanguageUse as any))
    return { ok: false, error: "Key Language Use must be Narrate, Inform, Explain, or Argue." };

  const duration = Number(body.duration ?? 45);
  if (!DURATIONS.includes(duration as any)) return { ok: false, error: "Unsupported lesson duration." };

  const rawLevels: unknown[] = Array.isArray(body.widaLevels) ? body.widaLevels : [];
  const widaLevels: number[] = [...new Set(rawLevels.map((x) => Number(x)))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
    .sort((a, b) => a - b); // numeric comparator — default sort is lexicographic

  if (widaLevels.length === 0) return { ok: false, error: "Select at least one WIDA proficiency level." };

  const topic = String(body.topic ?? "").trim().replace(/\s+/g, " ");
  if (topic.length < 3) return { ok: false, error: "Give the lesson a topic of at least 3 characters." };
  if (topic.length > 80) return { ok: false, error: "Keep the topic under 80 characters." };
  for (const [re, label] of PII_PATTERNS) {
    if (re.test(topic)) {
      return { ok: false, error: `That looks like a ${label}. The topic field is for lesson content only — no personal information is sent to the model.` };
    }
  }

  return { ok: true, payload: { gradeLevel, subject, topic, widaLevels, keyLanguageUse, duration } };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const LEVEL_SPEC = `WIDA ELD Standards Framework, 2020 Edition. Differentiate the sentence frame for each requested level using these specifications:
- Level 1 Entering: single-word fill-in. Supply a word bank of 2-4 options. Non-verbal or one-word response is a valid demonstration.
- Level 2 Emerging: one simple sentence, present or simple past. Key term pre-printed in the frame.
- Level 3 Developing: complex sentence using a conjunction (because, so, when, but, while). One or two clauses.
- Level 4 Expanding: short paragraph frame with explicit transition words the student fills between.
- Level 5 Bridging: academic language stems only, including nominalization and hedging where the Key Language Use calls for it. No content supplied.
- Level 6 Reaching: the scaffold is withdrawn. State the task and the independent language move expected. Do not supply a frame.`;

const SYSTEM = `You are an ELD instructional designer producing lesson scaffolding aligned to the WIDA ELD Standards Framework, 2020 Edition.

${LEVEL_SPEC}

Vocabulary uses the tiered model: Tier 1 everyday words, Tier 2 cross-curricular academic words, Tier 3 domain-specific terms. Tier 2 carries the most instructional leverage; Tier 3 is the content itself and is non-negotiable.

Hard rules:
- Scaffolding supports grade-level rigor. Never lower the cognitive demand of the content to accommodate language level. The science, math, or history stays the same at every level; only the language support changes.
- Language objectives must name the Key Language Use explicitly.
- Every level's support note must name a concrete, material support (a visual, a manipulative, a word bank, a partner structure, a gesture) — not a vague instruction like "provide support".
- Never invent, request, or reference any individual student. You receive no student information and must not produce placeholders for names.
- Write for a teacher who has 45 seconds to read this before students arrive. Be concrete and brief.

Return ONLY a JSON object matching this shape, with no markdown fences and no preamble:
{
  "titleSuggestion": string,
  "contentObjective": string,
  "languageObjective": string,
  "vocabulary": { "tier1": string[], "tier2": string[], "tier3": string[] },
  "levels": [ { "level": number, "name": string, "frame": string, "support": string } ],
  "formativeCheck": string,
  "watchFor": string
}
Include exactly one entry in "levels" for each requested WIDA level, in ascending order. Use "______" (six underscores) to mark blanks inside frames. "watchFor" names the single most likely way this lesson goes wrong for multilingual learners.`;

function userPrompt(p: Payload): string {
  return `Grade level: ${p.gradeLevel}
Subject: ${p.subject}
Topic: ${p.topic}
Key Language Use: ${p.keyLanguageUse}
WIDA proficiency levels present in the room: ${p.widaLevels.join(", ")}
Lesson duration: ${p.duration} minutes`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: (o) => (ORIGINS.includes(o) ? o : ORIGINS[0]),
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })
);

app.get("/health", (c) => {
  rollDay();
  return c.json({
    ok: true,
    model: MODEL,
    dayUsed: dayCount,
    dayCap: GLOBAL_PER_DAY,
    perIpPerHour: PER_IP_PER_HOUR,
  });
});

app.post("/api/generate/scaffold", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON." }, 400);
  }

  const v = validate(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);

  const ip = clientIp(c.req.raw);
  const g = gate(ip);
  if (!g.ok) {
    const error =
      g.reason === "daily_cap"
        ? "The demo has hit its daily generation cap. The page can still show its labeled designed sample output."
        : "That's several generations in a short window. Try again in an hour — the page can still show its labeled designed sample output.";
    return c.json({ ok: false, error, fallback: true }, 429);
  }

  const payload = v.payload;

  try {
    const started = Date.now();
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt(payload) }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return c.json(
        { ok: false, error: "The model returned something this endpoint couldn't parse. Try generating again.", fallback: true },
        502
      );
    }

    if (!Array.isArray(data?.levels) || data.levels.length === 0) {
      return c.json({ ok: false, error: "Generated output was missing its level breakdown. Try again.", fallback: true }, 502);
    }

    dayCount += 1;

    return c.json({
      ok: true,
      data,
      meta: {
        model: MODEL,
        ms: Date.now() - started,
        // Echoed back so the UI can show exactly what crossed the boundary.
        payloadSent: payload,
        remainingThisHour: g.remaining,
      },
    });
  } catch (err: any) {
    // Never leak provider internals or key state to the browser.
    console.error("generation failed:", err?.status ?? "", err?.message ?? err);
    const status = err?.status === 429 ? 429 : 502;
    return c.json(
      { ok: false, error: "The generation service is unavailable right now. The page can still show its labeled designed sample output.", fallback: true },
      status
    );
  }
});

app.notFound((c) => c.json({ ok: false, error: "Not found." }, 404));

console.log(`ELD AI demo API listening on :${PORT} — model ${MODEL}, cap ${GLOBAL_PER_DAY}/day`);

export default { port: PORT, fetch: app.fetch };
