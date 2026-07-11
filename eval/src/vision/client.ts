import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type VisionProvider = "anthropic" | "openai";

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

function pickProvider(): { provider: VisionProvider; model: string } | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      model: process.env.EVAL_VISION_MODEL ?? "claude-sonnet-5",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: process.env.EVAL_VISION_MODEL ?? "gpt-4.1",
    };
  }
  return null;
}

export function createVisionClient(): VisionClient | null {
  const picked = pickProvider();
  if (!picked) return null;

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
              : // @ts-expect-error SDK typings lag Sonnet 5 output_config
                { output_config: { effort } }),
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
  const slice = raw.slice(start);
  return JSON.parse(slice) as T;
}
