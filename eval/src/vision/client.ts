import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { resolveGeminiApiKey } from "../structure/redraw";

export type VisionProvider = "gemini" | "anthropic" | "openai";

export interface VisionMessage {
  system?: string;
  prompt: string;
  /** PNG/JPEG buffers with media types. */
  images: { data: Buffer; mediaType: "image/png" | "image/jpeg" }[];
  /** Prefer JSON object response. */
  json?: boolean;
}

export interface VisionClient {
  provider: VisionProvider;
  model: string;
  complete(msg: VisionMessage): Promise<string>;
}

/** Default multimodal reasoning model (not image-gen / Nano Banana). */
export const DEFAULT_GEMINI_VISION_MODEL = "gemini-3.5-flash";
const FALLBACK_GEMINI_VISION_MODEL = "gemini-3-flash-preview";

function resolveVisionProviderOverride(): VisionProvider | null {
  const raw = process.env.EVAL_VISION_PROVIDER?.trim().toLowerCase();
  if (raw === "gemini" || raw === "anthropic" || raw === "openai") return raw;
  return null;
}

function pickProvider(): { provider: VisionProvider; model: string } | null {
  const override = resolveVisionProviderOverride();
  const geminiKey = resolveGeminiApiKey();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const modelOverride = process.env.EVAL_VISION_MODEL?.trim();

  const candidates: { provider: VisionProvider; model: string; ok: boolean }[] = [
    {
      provider: "gemini",
      model: modelOverride || DEFAULT_GEMINI_VISION_MODEL,
      ok: Boolean(geminiKey),
    },
    {
      provider: "anthropic",
      model: modelOverride || "claude-sonnet-5",
      ok: Boolean(anthropicKey),
    },
    {
      provider: "openai",
      model: modelOverride || "gpt-4.1",
      ok: Boolean(openaiKey),
    },
  ];

  if (override) {
    const hit = candidates.find((c) => c.provider === override && c.ok);
    if (hit) return { provider: hit.provider, model: hit.model };
    return null;
  }

  // Default: Gemini 3.5 Flash for vision extract; Anthropic/OpenAI as fallbacks.
  for (const c of candidates) {
    if (c.ok) return { provider: c.provider, model: c.model };
  }
  return null;
}

function createGeminiClient(initialModel: string): VisionClient {
  const apiKey = resolveGeminiApiKey()!;
  const ai = new GoogleGenAI({ apiKey });
  const client: VisionClient = {
    provider: "gemini",
    model: initialModel,
    async complete(msg) {
      const parts: Array<
        | { text: string }
        | {
            inlineData: { data: string; mimeType: string };
            mediaResolution?: { level: string };
          }
      > = [
        ...msg.images.map((img) => ({
          inlineData: {
            data: img.data.toString("base64"),
            mimeType: img.mediaType,
          },
          // Prefer high detail for floor-plan pixel coords / OCR.
          mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" },
        })),
        { text: msg.prompt },
      ];

      const maxTokens = Number(process.env.EVAL_VISION_MAX_TOKENS ?? 65536);
      const config: {
        systemInstruction?: string;
        maxOutputTokens: number;
        responseMimeType?: string;
        mediaResolution?: string;
      } = {
        maxOutputTokens: maxTokens,
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
        ...(msg.system ? { systemInstruction: msg.system } : {}),
        ...(msg.json ? { responseMimeType: "application/json" } : {}),
      };

      const tryModels = [client.model];
      if (client.model === DEFAULT_GEMINI_VISION_MODEL) {
        tryModels.push(FALLBACK_GEMINI_VISION_MODEL);
      }

      let lastErr: Error | null = null;
      for (const m of tryModels) {
        try {
          const res = await ai.models.generateContent({
            model: m,
            contents: [{ role: "user", parts }],
            config,
          });
          const text = res.text?.trim() ?? "";
          if (!text) {
            throw new Error(
              `Empty Gemini vision text (model=${m}, finish=${res.candidates?.[0]?.finishReason ?? "?"})`,
            );
          }
          if (m !== client.model) client.model = m;
          return text;
        } catch (e) {
          lastErr = e as Error;
          const msgText = lastErr.message ?? String(e);
          // Only try alternate id on model-not-found / invalid-argument style failures.
          if (
            tryModels.length > 1 &&
            m === tryModels[0] &&
            /not found|invalid|404|model/i.test(msgText)
          ) {
            continue;
          }
          throw lastErr;
        }
      }
      throw lastErr ?? new Error("Gemini vision failed");
    },
  };
  return client;
}

export function createVisionClient(): VisionClient | null {
  const picked = pickProvider();
  if (!picked) return null;

  if (picked.provider === "gemini") {
    return createGeminiClient(picked.model);
  }

  if (picked.provider === "anthropic") {
    const client = new Anthropic({ timeout: 30 * 60 * 1000 });
    return {
      provider: "anthropic",
      model: picked.model,
      async complete(msg) {
        const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [
          ...msg.images.map(
            (img) =>
              ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: img.mediaType,
                  data: img.data.toString("base64"),
                },
              }) as const,
          ),
          { type: "text", text: msg.prompt },
        ];
        // Sonnet 5 defaults to adaptive thinking; thinking tokens count against
        // max_tokens. Prefer enough headroom for large dim JSON payloads.
        const maxTokens = Number(process.env.EVAL_VISION_MAX_TOKENS ?? 32000);
        const effort = (process.env.EVAL_VISION_EFFORT ?? "medium") as
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max";
        // Structured JSON extraction is more reliable without adaptive thinking
        // eating the output budget (default off; set EVAL_VISION_NO_THINKING=0 to enable).
        const disableThinking = process.env.EVAL_VISION_NO_THINKING !== "0";
        const res = await client.messages.create(
          {
            model: picked.model,
            max_tokens: maxTokens,
            system: msg.system,
            messages: [{ role: "user", content }],
            ...(disableThinking
              ? { thinking: { type: "disabled" as const } }
              : { output_config: { effort } }),
          },
          { timeout: 30 * 60 * 1000 },
        );
        const text = res.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n");
        if (!text.trim()) {
          const thinking = res.content.some((b) => b.type === "thinking");
          throw new Error(
            `Empty vision text (stop_reason=${res.stop_reason}, thinking=${thinking}, ` +
              `out=${res.usage.output_tokens}/${maxTokens}). Raise EVAL_VISION_MAX_TOKENS, ` +
              `lower EVAL_VISION_EFFORT, or set EVAL_VISION_NO_THINKING=1.`,
          );
        }
        return text;
      },
    };
  }

  const client = new OpenAI();
  return {
    provider: "openai",
    model: picked.model,
    async complete(msg) {
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
        ...msg.images.map((img) => ({
          type: "image_url" as const,
          image_url: {
            url: `data:${img.mediaType};base64,${img.data.toString("base64")}`,
            detail: "high" as const,
          },
        })),
        { type: "text", text: msg.prompt },
      ];
      const res = await client.chat.completions.create({
        model: picked.model,
        max_completion_tokens: 8096,
        response_format: msg.json ? { type: "json_object" } : undefined,
        messages: [
          ...(msg.system ? [{ role: "system" as const, content: msg.system }] : []),
          { role: "user", content: parts },
        ],
      });
      return res.choices[0]?.message?.content ?? "";
    },
  };
}

/** Extract the first balanced JSON object/array from text (ignores trailing prose). */
function extractBalancedJson(raw: string, start: number): string {
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

export function parseJsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  // Find outermost object/array
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  let start = -1;
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
  else start = startArr;
  if (start < 0) throw new Error(`No JSON in vision response: ${text.slice(0, 200)}`);
  const slice = extractBalancedJson(raw, start);
  try {
    return JSON.parse(slice) as T;
  } catch (first) {
    // Common LLM slip: trailing commas before } or ]
    const repaired = slice.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(repaired) as T;
    } catch {
      throw first;
    }
  }
}
