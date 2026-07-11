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
    const client = new Anthropic();
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
        const res = await client.messages.create({
          model: picked.model,
          max_tokens: 8096,
          system: msg.system,
          messages: [{ role: "user", content }],
        });
        const text = res.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n");
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
