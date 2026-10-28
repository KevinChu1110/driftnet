import { readFileSync } from "node:fs";
import type { Store } from "./store.ts";

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

const OTHER = "Anything that fits none of the above";

/**
 * Starting folder trees for a first run (DRIFTNET_FOLDERS=ai|research|everyday).
 * "other" is in every one: it is the fallback folder id the pipeline relies on.
 */
export const FOLDER_TEMPLATES = {
  ai: DEFAULT_CATEGORIES,
  research: {
    papers: "Research papers, preprints, journal articles and their summaries",
    articles: "Essays, blog posts, long reads, newsletters and explainers worth keeping as reading notes",
    datasets: "Datasets, corpora, benchmarks and data sources",
    methods: "Methods, techniques, algorithms, experiment designs and statistics",
    "research-tools": "Software, libraries, reference managers, notebooks and services for doing research",
    "people-talks": "Researchers, lectures, conference talks, podcasts and interviews",
    "to-read": "Interesting but not read yet: reading lists, saved for later, unclear fit",
    other: OTHER,
  },
  everyday: {
    cooking: "Recipes, cooking techniques, kitchen gear, restaurants and food",
    travel: "Destinations, itineraries, flights, hotels, maps and travel tips",
    health: "Health, fitness, sleep, nutrition, mental wellbeing and medical information",
    money: "Personal finance, budgeting, investing, taxes, deals and insurance",
    home: "Home, repairs, DIY, furniture, gardening, cleaning and household gadgets",
    learning: "Courses, tutorials, languages, books and skills to learn",
    entertainment: "Movies, shows, games, music, books for fun, events and hobbies",
    shopping: "Products to buy, reviews, comparisons and gift ideas",
    other: OTHER,
  },
} as const satisfies Record<string, Record<string, string>>;

export type FolderTemplate = keyof typeof FOLDER_TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(FOLDER_TEMPLATES) as FolderTemplate[];
export const isTemplate = (x: unknown): x is FolderTemplate => typeof x === "string" && x in FOLDER_TEMPLATES;

/** DRIFTNET_CATEGORIES (a json file) wins; else DRIFTNET_FOLDERS picks a template; default "ai". */
export function loadCategories(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = env.DRIFTNET_CATEGORIES;
  if (!path) return { ...FOLDER_TEMPLATES[isTemplate(env.DRIFTNET_FOLDERS) ? env.DRIFTNET_FOLDERS : "ai"] };
  const custom = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return "other" in custom ? custom : { ...custom, other: DEFAULT_CATEGORIES.other! };
}

export class TemplateError extends Error {}

/**
 * Replace the untouched starter folders with another template. Only while the
 * catalogue is empty and every folder is still a seeded one (not created,
 * renamed or moved by the reader): otherwise it would throw their work away.
 */
export function applyFolderTemplate(store: Store, template: string): FolderTemplate {
  if (!isTemplate(template)) throw new TemplateError(`unknown template ${template}`);
  if (store.itemCount() > 0) throw new TemplateError("the catalogue already has items");
  if (store.folders().some((f) => !f.builtin || f.name !== null || f.parent !== null)) throw new TemplateError("your folders have been changed");
  store.replaceFolders({ ...FOLDER_TEMPLATES[template] });
  return template;
}
