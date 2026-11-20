/**
 * Provider-agnostic LLM + embedding layer.
 *
 * Choose a provider with environment variables (see .env.example):
 *   LLM_PROVIDER        gemini | openai | anthropic      (default: gemini)
 *   LLM_API_KEY         falls back to GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
 *   LLM_MODEL           model name for text generation
 *   LLM_BASE_URL        for OpenAI-compatible servers (Groq, OpenRouter, Together, Ollama, LM Studio, Azure proxy…)
 *
 *   EMBEDDING_PROVIDER  gemini | openai                  (default: gemini, or openai when LLM_PROVIDER=openai)
 *   EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_BASE_URL
 *
 * Embeddings are always 768-dimensional to match the database (vector(768)).
 */
import { GoogleGenAI } from "@google/genai";

export const EMBEDDING_DIMENSIONS = 768;

type Provider = "gemini" | "openai" | "anthropic";
type EmbeddingProvider = "gemini" | "openai";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  system: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: { input: number; output: number };
}

const env = (k: string) => (process.env[k] || "").trim();

function llmConfig() {
  const provider = (env("LLM_PROVIDER") || "gemini").toLowerCase() as Provider;
  const apiKey =
    env("LLM_API_KEY") ||
    (provider === "gemini" ? env("GEMINI_API_KEY") : provider === "openai" ? env("OPENAI_API_KEY") : env("ANTHROPIC_API_KEY"));
  const model =
    env("LLM_MODEL") ||
    env(provider === "gemini" ? "GEMINI_MODEL" : "") ||
    (provider === "gemini" ? "gemini-3.5-flash-lite" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-5-5");
  const baseUrl =
    env("LLM_BASE_URL") || (provider === "openai" ? "https://api.openai.com/v1" : provider === "anthropic" ? "https://api.anthropic.com" : "");
  return { provider, apiKey, model, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function embeddingConfig() {
  const llm = llmConfig();
  const provider = (env("EMBEDDING_PROVIDER") || (llm.provider === "openai" ? "openai" : "gemini")).toLowerCase() as EmbeddingProvider;
  const apiKey =
    env("EMBEDDING_API_KEY") ||
    (provider === llm.provider ? llm.apiKey : "") ||
    (provider === "gemini" ? env("GEMINI_API_KEY") : env("OPENAI_API_KEY"));
  const model =
    env("EMBEDDING_MODEL") || env(provider === "gemini" ? "GEMINI_EMBEDDING_MODEL" : "") ||
    (provider === "gemini" ? "gemini-embedding-001" : "text-embedding-3-small");
  const baseUrl = (env("EMBEDDING_BASE_URL") || (provider === "openai" ? (llm.provider === "openai" ? llm.baseUrl : "https://api.openai.com/v1") : "")).replace(/\/+$/, "");
  return { provider, apiKey, model, baseUrl };
}

/** Safe summary of the configuration (no secrets), used by /api/health. */
export function describeAiConfig() {
  const l = llmConfig();
  const e = embeddingConfig();
  return {
    llm: { provider: l.provider, model: l.model, configured: !!l.apiKey || isLocalUrl(l.baseUrl) },
    embeddings: { provider: e.provider, model: e.model, configured: !!e.apiKey || isLocalUrl(e.baseUrl) },
  };
}

function isLocalUrl(u: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal|ollama)/.test(u);
}

class ProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

/** Turns provider errors (often raw JSON) into a short, actionable message. */
function friendlyProviderError(e: any): Error {
  const msg = String(e?.message || e || "");
  if (/API_KEY_INVALID|API key not valid|invalid[_ ]api[_ ]key|incorrect api key|authentication_error|401/i.test(msg)) {
    return new ProviderError("The AI provider rejected the API key. Check LLM_API_KEY (or GEMINI_API_KEY) in your .env file and restart the server.", 401);
  }
  if (/quota|RESOURCE_EXHAUSTED|rate.?limit|429/i.test(msg)) {
    return new ProviderError("The AI provider's rate limit or quota was reached. Please try again in a minute.", 429);
  }
  if (/model.*not found|NOT_FOUND|does not exist|404/i.test(msg)) {
    return new ProviderError("The configured AI model was not found. Check LLM_MODEL / EMBEDDING_MODEL in your .env file.", 404);
  }
  const clean = msg.replace(/\s+/g, " ").slice(0, 200);
  return new ProviderError(clean || "The AI provider returned an error.", e?.status);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const status = e?.status ?? e?.code;
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        return await fn();
      } catch (e2) {
        throw friendlyProviderError(e2);
      }
    }
    throw friendlyProviderError(e);
  }
}

let geminiClient: GoogleGenAI | null = null;
function gemini(apiKey: string) {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

/** Merges consecutive messages from the same role and makes sure the list starts with a user turn. */
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m.content?.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const cfg = llmConfig();
  if (!cfg.apiKey && !isLocalUrl(cfg.baseUrl)) {
    throw new ProviderError(`No API key configured for LLM provider "${cfg.provider}". Set LLM_API_KEY.`);
  }
  const messages = normalizeMessages(opts.messages);
  const maxTokens = opts.maxTokens ?? 1500;
  const temperature = opts.temperature ?? 0.2;
  const system = opts.json ? `${opts.system}\n\nRespond with a single valid JSON object only.` : opts.system;

  return withRetry(async () => {
    if (cfg.provider === "gemini") {
      const res = await gemini(cfg.apiKey).models.generateContent({
        model: cfg.model,
        contents: messages.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] })),
        config: {
          systemInstruction: system,
          maxOutputTokens: maxTokens,
          temperature,
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
        },
      });
      if (!res.text) throw new ProviderError("Empty response from Gemini");
      return {
        text: res.text,
        model: cfg.model,
        usage: { input: res.usageMetadata?.promptTokenCount || 0, output: res.usageMetadata?.candidatesTokenCount || 0 },
      };
    }

    if (cfg.provider === "openai") {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [{ role: "system", content: system }, ...messages],
        max_tokens: maxTokens,
        temperature,
      };
      if (opts.json && env("LLM_JSON_MODE") !== "false") body.response_format = { type: "json_object" };
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new ProviderError(`LLM API error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new ProviderError("Empty response from LLM");
      return {
        text,
        model: data.model || cfg.model,
        usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
      };
    }

    // anthropic
    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: cfg.model, system, messages, max_tokens: maxTokens, temperature }),
    });
    if (!res.ok) throw new ProviderError(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    const data = await res.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (!text) throw new ProviderError("Empty response from Anthropic");
    return {
      text,
      model: data.model || cfg.model,
      usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
    };
  });
}

/** Parses JSON even when a model wraps it in ``` fences or adds text around it. */
export function parseJsonLoose(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return valid JSON");
  }
}

export async function embed(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = embeddingConfig();
  if (!cfg.apiKey && !isLocalUrl(cfg.baseUrl)) {
    throw new ProviderError(`No API key configured for embedding provider "${cfg.provider}". Set EMBEDDING_API_KEY.`);
  }
  const inputs = texts.map((t) => t.slice(0, 8000));

  const vectors: number[][] = await withRetry(async (): Promise<number[][]> => {
    if (cfg.provider === "gemini") {
      const res = await gemini(cfg.apiKey).models.embedContent({
        model: cfg.model,
        contents: inputs,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType },
      });
      return (res.embeddings || []).map((e) => e.values || []);
    }
    const body: Record<string, unknown> = { model: cfg.model, input: inputs };
    if (/^text-embedding-3/.test(cfg.model)) body.dimensions = EMBEDDING_DIMENSIONS;
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError(`Embedding API error ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    const data = await res.json();
    return (data.data || []).sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding as number[]);
  });

  if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    throw new ProviderError(
      `Embedding model must return ${EMBEDDING_DIMENSIONS}-dimensional vectors (got ${vectors[0]?.length ?? 0}). Choose a 768-dim model or one that supports a dimensions parameter.`
    );
  }
  return vectors;
}
