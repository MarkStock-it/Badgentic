import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Versioned prompt templates (spec §5.2): prompts live in files, not inline
 * strings. First line must be `<!-- version: N -->`; every AI call logs
 * templateId + version into run_logs so a bad rollout is diagnosable.
 */
const here = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(here, 'prompts');

function renderTemplate(text, context) {
  return text.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), context);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  });
}

function loadTemplate(templateId, relPath) {
  const full = join(PROMPTS_DIR, relPath);
  const text = readFileSync(full, 'utf8');
  const versionMatch = /<!--\s*version:\s*(\d+)\s*-->/.exec(text);
  return {
    id: templateId,
    version: versionMatch ? Number(versionMatch[1]) : 1,
    body: text.replace(/^<!--[^>]*-->\s*/, ''),
    render(context) {
      return renderTemplate(this.body, context);
    },
  };
}

/** Load all templates once at factory time; tests can point at their own dir. */
export function loadPromptTemplates({ dir = PROMPTS_DIR } = {}) {
  const templates = new Map();
  const files = readdirSync(dir);

  for (const file of files) {
    if (file.endsWith('.md.tmpl')) {
      const id = file.replace(/\.md\.tmpl$/, '');
      templates.set(id, loadTemplate(id, file));
    }
  }

  const genDir = join(dir, 'generate');
  if (existsSync(genDir)) {
    for (const file of readdirSync(genDir)) {
      if (file.endsWith('.md.tmpl')) {
        const id = file.replace(/\.md\.tmpl$/, '');
        templates.set(`generate/${id}`, loadTemplate(`generate/${id}`, join('generate', file)));
      }
    }
  }

  return templates;
}

/**
 * AI-facing surface (spec §5.5):
 *   ai.generate({ templateId, context }) → { text, usage }
 *   ai.generateStructured({ templateId, context, schemaHint }) → { json, usage }
 * Gemini first; Groq as structured-output fallback. Usage logged per call.
 */
export function createAiClient({ aiKeys, fetchImpl = globalThis.fetch.bind(globalThis), log }) {
  const templates = loadPromptTemplates();

  function requireTemplate(templateId) {
    const t = templates.get(templateId);
    if (!t) throw new Error(`Unknown prompt template: ${templateId}`);
    return t;
  }

  async function callGemini(prompt, { json = false, signal } = {}) {
    const model = 'gemini-2.0-flash';
    const started = Date.now();
    const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(aiKeys.gemini)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
        }),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}: ${body?.error?.message || 'unknown'}`);
      err.status = res.status;
      err.provider = 'gemini';
      throw err;
    }
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    return {
      text,
      usage: {
        provider: 'gemini',
        model,
        latencyMs: Date.now() - started,
        promptTokens: body?.usageMetadata?.promptTokenCount ?? null,
        completionTokens: body?.usageMetadata?.candidatesTokenCount ?? null,
      },
    };
  }

  async function callGroq(prompt, { json = false, signal } = {}) {
    const model = 'llama-3.3-70b-versatile';
    const started = Date.now();
    const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKeys.groq}` },
      signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Groq HTTP ${res.status}: ${body?.error?.message || 'unknown'}`);
      err.status = res.status;
      err.provider = 'groq';
      throw err;
    }
    return {
      text: body?.choices?.[0]?.message?.content || '',
      usage: {
        provider: 'groq',
        model,
        latencyMs: Date.now() - started,
        promptTokens: body?.usage?.prompt_tokens ?? null,
        completionTokens: body?.usage?.completion_tokens ?? null,
      },
    };
  }

  function extractJson(text) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const raw = (fenced ? fenced[1] : text).trim();
    const start = raw.search(/[[{]/);
    if (start === -1) throw new Error('No JSON found in model output');
    return JSON.parse(raw.slice(start));
  }

  return {
    hasGemini: Boolean(aiKeys.gemini),
    hasGroq: Boolean(aiKeys.groq),

    async generate({ templateId, context, signal }) {
      const t = requireTemplate(templateId);
      const prompt = t.render(context);
      if (aiKeys.gemini) return callGemini(prompt, { signal });
      if (aiKeys.groq) return callGroq(prompt, { signal });
      const err = new Error('No AI provider key configured');
      err.code = 'BYOK_MISSING';
      throw err;
    },

    async generateStructured({ templateId, context, signal }) {
      const t = requireTemplate(templateId);
      const prompt = t.render(context);
      const attempts = [];
      if (aiKeys.gemini) attempts.push(['gemini', () => callGemini(prompt, { json: true, signal })]);
      if (aiKeys.groq) attempts.push(['groq', () => callGroq(prompt, { json: true, signal })]);
      if (attempts.length === 0) {
        const err = new Error('No AI provider key configured');
        err.code = 'BYOK_MISSING';
        throw err;
      }
      let lastErr;
      for (const [provider, call] of attempts) {
        try {
          const { text, usage } = await call();
          return { json: extractJson(text), usage: { ...usage, templateId, templateVersion: t.version } };
        } catch (err) {
          lastErr = err;
          log?.warn({ provider, err: err.message, templateId }, 'structured generation failed, trying next provider');
        }
      }
      throw lastErr;
    },

    templateVersion(templateId) {
      return templates.get(templateId)?.version ?? null;
    },
  };
}
