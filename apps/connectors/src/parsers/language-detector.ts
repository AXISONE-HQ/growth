/**
 * KAN-1140 Phase 2 — Email body language detection.
 *
 * Wraps `franc-min` (trigram-based language identifier) and emits an ordinal
 * confidence score consistent with the format-detector convention from
 * PR #304. Returns ISO 639-1 codes (`en`, `fr`, `es`, ...) to align with
 * `AccountProfile.defaultLanguage` + `AccountProfile.supportedLanguages`
 * schema columns; franc-min itself emits ISO 639-3 (`eng`, `fra`, `spa`).
 *
 * Confidence model (ordinal high/medium/low matches format-detector):
 *   high   — franc-min returned a non-`und` code with `francAll[0]` score >= 0.8
 *   medium — score >= 0.5
 *   low    — score < 0.5 OR detection returned `und` (under-length / unrecognizable)
 *
 * Q4(c') fallback hierarchy lives in `resolveLanguage()`:
 *   1. high  → use detected
 *   2. medium AND detected ∈ supportedLanguages → use detected
 *   3. else → tenant defaultLanguage → 'en'
 *
 * The hierarchy honors `AccountProfile.supportedLanguages` — tenants declaring
 * `["en"]` won't have low-confidence French misclassifications leak through.
 */
import { francAll } from "franc-min";

export type LanguageConfidence = "high" | "medium" | "low";

export interface LanguageDetection {
  /** ISO 639-1 (`en`, `fr`, `es`, ...). Null when input was empty/whitespace. */
  language: string | null;
  confidence: LanguageConfidence;
  /** Raw franc-min top-tuple score (0-1). Null when no detection ran. */
  score: number | null;
}

const ISO_639_3_TO_1: Record<string, string> = {
  eng: "en",
  fra: "fr",
  spa: "es",
  deu: "de",
  ita: "it",
  por: "pt",
  nld: "nl",
  rus: "ru",
  pol: "pl",
  jpn: "ja",
  kor: "ko",
  zho: "zh",
  cmn: "zh", // Mandarin Chinese
  ara: "ar",
  tur: "tr",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  ell: "el",
  heb: "he",
  hin: "hi",
  ind: "id",
  vie: "vi",
  tha: "th",
  ces: "cs",
  hun: "hu",
  ron: "ro",
};

const HIGH_THRESHOLD = 0.8;
const MEDIUM_THRESHOLD = 0.5;

/**
 * Detect the language of an email body. Returns null on empty/whitespace.
 *
 * `text` is the plain-text body (preferred over HTML; caller should pass the
 * format-detected text after KAN-1140 PR 1's per-format pre-parser strips
 * markup). franc-min works best on >=3 sentences; very short input → low
 * confidence + caller falls through to tenant defaults.
 */
export function detectLanguage(text: string | null | undefined): LanguageDetection | null {
  const cleaned = (text ?? "").trim();
  if (cleaned.length === 0) return null;

  const top3 = francAll(cleaned).slice(0, 3);
  const [topCode, topScore] = top3[0] ?? ["und", 0];

  if (topCode === "und") {
    return { language: null, confidence: "low", score: topScore };
  }

  const iso1 = ISO_639_3_TO_1[topCode] ?? topCode;
  const confidence: LanguageConfidence =
    topScore >= HIGH_THRESHOLD
      ? "high"
      : topScore >= MEDIUM_THRESHOLD
        ? "medium"
        : "low";

  return { language: iso1, confidence, score: topScore };
}

/**
 * KAN-1140 Phase 2 Q4(c') — supportedLanguages-aware fallback hierarchy.
 *
 * The tenant's declared `AccountProfile.supportedLanguages` is operator intent:
 * "these are the languages my customers communicate in." Respecting it means a
 * tenant declaring `["en"]` doesn't get medium-confidence French extraction
 * dragging in English-speaking-customer leads as French.
 *
 * Rules:
 *   1. detected.confidence === 'high' → use detected.language (operator-declared
 *      or not — high confidence beats declared intent)
 *   2. detected.confidence === 'medium' AND detected.language ∈ supportedLanguages
 *      → use detected.language (declared intent honored)
 *   3. else → defaultLanguage → 'en' (final defensive fallback)
 *
 * Null detection (empty input) → defaultLanguage → 'en'.
 */
export function resolveLanguage(
  detected: LanguageDetection | null,
  supportedLanguages: readonly string[] | null | undefined,
  defaultLanguage: string | null | undefined,
): string {
  const fallback = defaultLanguage?.trim() || "en";

  if (!detected || !detected.language) return fallback;

  if (detected.confidence === "high") return detected.language;

  if (
    detected.confidence === "medium" &&
    supportedLanguages &&
    supportedLanguages.includes(detected.language)
  ) {
    return detected.language;
  }

  return fallback;
}
