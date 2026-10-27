// Voice fit (M34): the default Kokoro voice and pace picked from who uses the app — the app
// brief's "Who uses it" (src/brief, decision 33). A small deterministic keyword mapping, only
// when `config.voice` sets neither a voice nor a speed; anything in the config (or a
// walkthrough's own `voice:`) wins. Professional audiences keep Kokoro's default voice, so most
// apps sound exactly as before.
import { briefPath, loadBrief } from "../brief/consumers.js";
import { briefReaders, findSection, sectionText } from "../brief/format.js";
import { DEFAULT_KOKORO_VOICE } from "./providers/kokoro.js";

export interface VoiceFit {
  voice: string;
  speed: number;
  /** Which audience matched, in plain words. */
  reason: string;
}

const RULES: { test: RegExp; voice: string; speed: number; reason: string }[] = [
  // People new to software, or using it rarely: a little slower.
  {
    test: /\b(senior|seniors|elderly|older (people|adults|users)|first[- ]time|non[- ]technical|not (very )?technical|occasional|beginners?|new to computers)\b/i,
    voice: DEFAULT_KOKORO_VOICE,
    speed: 0.92,
    reason: "people new to software: a slower pace",
  },
  // Consumers, families, students, volunteers: a warmer voice.
  {
    test: /\b(kids|children|families|parents|students|pupils|learners|volunteers|shoppers|fans|players)\b/i,
    voice: "af_bella",
    speed: 1,
    reason: "a general audience: a warmer voice",
  },
  // Technical audiences: a brisker pace.
  {
    test: /\b(developers?|engineers?|devops|sysadmins?|data (analysts?|scientists?)|analysts?|IT (staff|team|admins?))\b/i,
    voice: "am_michael",
    speed: 1.05,
    reason: "a technical audience: a brisker pace",
  },
];

/** The voice and pace for an audience description; undefined for the default (professional). */
export function voiceFitFor(whoUsesIt: string): VoiceFit | undefined {
  for (const r of RULES) if (r.test.test(whoUsesIt)) return { voice: r.voice, speed: r.speed, reason: r.reason };
  return undefined;
}

/** From the config's app brief, when `config.voice` leaves voice and speed unset and the provider
 * is Kokoro (other providers' voice ids are their own). */
export function voiceFitForConfig(config: {
  configDir: string;
  brief?: string;
  voice?: { provider?: string; voiceId?: string; speed?: number };
}, provider = config.voice?.provider ?? "kokoro"): VoiceFit | undefined {
  if (provider !== "kokoro" || config.voice?.voiceId || config.voice?.speed !== undefined) return undefined;
  let brief;
  try {
    brief = loadBrief(briefPath(config));
  } catch {
    return undefined;
  }
  if (!brief) return undefined;
  const who = [sectionText(findSection(brief, "Who uses it")), ...briefReaders(brief).map((r) => `${r.name} ${r.job}`)].join("\n");
  return who.trim() ? voiceFitFor(who) : undefined;
}
