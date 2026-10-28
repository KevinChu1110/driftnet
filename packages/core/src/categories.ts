import { readFileSync } from "node:fs";

/**
 * The shelf every item lands on. Keys are stable ids (stored in the DB, used in
 * URLs); descriptions are what the judge reads, so make them discriminating.
 *
 * Override with DRIFTNET_CATEGORIES=/path/to/categories.json ({ "id": "description" }).
 */
export const DEFAULT_CATEGORIES: Record<string, string> = {
  "coding-agent": "AI coding assistants, coding agents, IDEs and their plugins, skills or prompts for them",
  "agent-framework": "Frameworks, SDKs and protocols for building AI agents or LLM apps (incl. MCP servers)",
  "chat-assistant": "End-user chatbots and assistants, AI search, AI browsers",
  "image-video": "Image, video, 3D or design generation and editing",
  "design-frontend": "Web and UI design, frontend libraries and effects, design skills or prompts for AI coding tools",
  "audio-voice": "Speech, voice cloning, music and audio generation, transcription",
  "automation": "Workflow automation, no-code AI tools, browser or desktop automation, bots",
  "knowledge-rag": "Notes, knowledge bases, RAG, document parsing, personal memory",
  "model-infra": "Models, inference, fine-tuning, local LLM runners, evals, GPUs",
  "productivity": "Office, writing, slides, meetings, email and other daily-work tools",
  "news": "AI news roundups, weekly digests, release announcements, industry updates",
  "learning": "Tutorials, courses, guides, papers, curated lists about AI",
  "other": "Anything that fits none of the above",
};

export function loadCategories(): Record<string, string> {
  const path = process.env.DRIFTNET_CATEGORIES;
  if (!path) return DEFAULT_CATEGORIES;
  const custom = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return "other" in custom ? custom : { ...custom, other: DEFAULT_CATEGORIES.other! };
}
