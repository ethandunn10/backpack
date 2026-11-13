// Backpack AI endpoint (Vercel serverless function).
// Keeps the API key on the server. Only does the two jobs Backpack needs
// (read homework, make a quiz), so nobody can use your key as a free chatbot.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 1_400_000;   // ~1 MB per photo after shrinking
const MAX_TEXT = 6000;

// Simple per-IP rate limit (resets when the server restarts; good enough for a hackathon)
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 25;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_HITS;
}

const KINDS = { hw: "Homework", test: "Test", quiz: "Quiz", project: "Project" };
const s = (v, n) => String(v ?? "").slice(0, n);

function extractPrompt(text, nImages, today, weekday) {
  return `You are Backpack, a homework memory assistant for a high school student.
Today is ${weekday}, ${today} (YYYY-MM-DD).

The student gave you ${nImages ? nImages + " photo(s) of school material" : "no photos"}${text ? " and this text:\n\"\"\"\n" + text + "\n\"\"\"" : "."}

Find every assignment, test, quiz, or project in it. For each one, return:
- kind: "hw" | "test" | "quiz" | "project"
- title: short, specific (e.g. "Cellular respiration worksheet")
- subject: class name (e.g. "Biology", "Precalc", "English"); guess from the content if not stated
- due: due date as YYYY-MM-DD. Convert relative dates ("Thursday", "next Tuesday", "tomorrow") using today's date. Use null if no date is given at all.
- topics: 2-6 short topic names it covers
- notes: the actual content worth studying, as compact study notes (key terms, definitions, formulas, facts, the questions asked). Max 900 characters. Practice quizzes are built from this, so be concrete and accurate. Only use what's in the material plus standard textbook facts about those exact topics.

If the material is just notes with no assignment, return one item of kind "hw" titled "Study notes: <topic>" with due null.
If there is nothing school-related at all, return {"items":[]}.
Reply with ONLY JSON exactly like: {"items":[{"kind":"hw","title":"","subject":"","due":"YYYY-MM-DD","topics":[""],"notes":""}]}`;
}

function quizPrompt(test, related) {
  const mats = related.map(r =>
    `- [${KINDS[r.kind] || "Homework"}] ${s(r.title, 120)} (${s(r.subject, 40)})\n  Topics: ${(r.topics || []).map(t => s(t, 40)).slice(0, 8).join(", ")}\n  Notes: ${s(r.notes, 1200)}`
  ).join("\n");
  return `You are Backpack, a study buddy. Make a practice quiz for this upcoming ${KINDS[test.kind] || "test"}:
"${s(test.title, 120)}" in ${s(test.subject, 40)}. Topics: ${(test.topics || []).map(t => s(t, 40)).slice(0, 8).join(", ") || "see materials"}.
Test notes: ${s(test.notes, 1200)}

Build the questions FROM THE STUDENT'S OWN HOMEWORK AND NOTES below (that's the whole point). Prefer facts, terms and problem types that appear there.
${mats || "(no extra homework saved; use the test notes and topics)"}

Rules:
- 8 multiple-choice questions, 4 options each, exactly one correct.
- Mix recall, understanding, and at least 2 apply/problem questions.
- Each question has "topic" (one of the topics), "from" (which homework/notes title it's based on), and a 1-2 sentence "explain" of why the answer is right.
- Be factually correct. No trick questions. No "all of the above".
Reply with ONLY JSON: {"questions":[{"q":"","options":["","","",""],"answer":0,"topic":"","from":"","explain":""}]}`;
}

function parseJSON(text) {
  const m = String(text || "").match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new Error("bad_ai_reply");
  return JSON.parse(m[0]);
}

// JSON schemas for structured outputs: the API guarantees the reply matches these,
// so a stray quote inside a question can't break the JSON anymore.
const str = { type: "string" };
const strList = { type: "array", items: str };
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["hw", "test", "quiz", "project"] },
          title: str,
          subject: str,
          due: { anyOf: [str, { type: "null" }] },
          topics: strList,
          notes: str,
        },
        required: ["kind", "title", "subject", "due", "topics", "notes"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};
const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { q: str, options: strList, answer: { type: "integer" }, topic: str, from: str, explain: str },
        required: ["q", "options", "answer", "topic", "from", "explain"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

async function callClaude(content, maxTokens, schema) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
      ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `AI error ${r.status}`;
    const err = new Error(msg); err.status = r.status; throw err;
  }
  // A cut-off or declined reply has no complete JSON in it, so fail clearly instead of parsing half an answer.
  if (data.stop_reason === "max_tokens" || data.stop_reason === "refusal") throw new Error(`ai_${data.stop_reason}`);
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: "setup", message: "The AI key isn't set up yet. Add ANTHROPIC_API_KEY in Vercel, then redeploy." });

    const code = String(req.headers["x-access-code"] || "");
    const need = process.env.ACCESS_CODE || "";
    if (need && code !== need) return send(res, 401, { error: "code", message: "Wrong access code." });

    if (req.method === "GET") return send(res, 200, { ok: true });
    if (req.method !== "POST") return send(res, 405, { error: "method" });

    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "x").split(",")[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: "slow", message: "Whoa, slow down. Try again in a few minutes." });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    if (body.task === "extract") {
      const text = s(body.text, MAX_TEXT).trim();
      const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
        .filter(i => i && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && typeof i.data === "string" && i.data.length <= MAX_IMAGE_B64);
      if (!text && !imgs.length) return send(res, 400, { error: "empty", message: "Add a photo or some text first." });
      const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
      const weekday = s(body.weekday, 12) || "";
      const content = [
        ...imgs.map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
        { type: "text", text: extractPrompt(text, imgs.length, today, weekday) },
      ];
      const out = parseJSON(await callClaude(content, 8000, EXTRACT_SCHEMA));
      return send(res, 200, { items: Array.isArray(out.items) ? out.items.slice(0, 12) : [] });
    }

    if (body.task === "quiz") {
      const test = body.test || {};
      const related = (Array.isArray(body.related) ? body.related : []).slice(0, 6);
      const out = parseJSON(await callClaude(quizPrompt(test, related), 8000, QUIZ_SCHEMA));
      return send(res, 200, { questions: Array.isArray(out.questions) ? out.questions.slice(0, 10) : [] });
    }

    return send(res, 400, { error: "task" });
  } catch (e) {
    console.error(e);
    const status = e.status === 429 ? 429 : 500;
    return send(res, status, { error: "ai", message: status === 429 ? "AI is busy. Try again in a minute." : "The AI had a problem. Try again." });
  }
}
