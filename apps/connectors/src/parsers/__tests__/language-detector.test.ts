/**
 * KAN-1140 Phase 2 — Language detector unit tests.
 *
 * Pure-function tests; no mocks required. Tests cover:
 *   - franc-min happy paths (en / fr / es) on adequate-length samples
 *   - Short / empty / whitespace inputs → null or low-confidence
 *   - Confidence ordinal boundary cases
 *   - resolveLanguage Q4(c') fallback hierarchy (all 6 branches)
 */
import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  resolveLanguage,
  type LanguageDetection,
} from "../language-detector.js";

// Long-enough samples to give franc-min stable trigram coverage.
const EN_SAMPLE =
  "Hi team, I would like to learn about your enterprise pricing tier. " +
  "We are evaluating several vendors and would appreciate a demo this week. " +
  "Please let me know what times work for your sales team. Thanks!";
const FR_SAMPLE =
  "Bonjour, je souhaiterais obtenir des informations sur votre offre tarifaire " +
  "entreprise. Nous évaluons plusieurs prestataires et aimerions assister à une " +
  "démonstration cette semaine. Merci de me communiquer vos disponibilités.";
const ES_SAMPLE =
  "Hola, me gustaría obtener información sobre su nivel de precios empresarial. " +
  "Estamos evaluando varios proveedores y agradeceríamos una demostración esta " +
  "semana. Por favor, indíqueme qué horarios funcionan para su equipo de ventas.";

describe("detectLanguage — happy paths", () => {
  it("detects English on a multi-sentence English body", () => {
    const r = detectLanguage(EN_SAMPLE);
    expect(r?.language).toBe("en");
    expect(r?.confidence === "high" || r?.confidence === "medium").toBe(true);
  });

  it("detects French on a multi-sentence French body", () => {
    const r = detectLanguage(FR_SAMPLE);
    expect(r?.language).toBe("fr");
    expect(r?.confidence === "high" || r?.confidence === "medium").toBe(true);
  });

  it("detects Spanish on a multi-sentence Spanish body", () => {
    const r = detectLanguage(ES_SAMPLE);
    expect(r?.language).toBe("es");
    expect(r?.confidence === "high" || r?.confidence === "medium").toBe(true);
  });
});

describe("detectLanguage — edge cases", () => {
  it("returns null on empty input", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("   \n  ")).toBeNull();
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage(undefined)).toBeNull();
  });

  it("returns low confidence when franc-min cannot determine (returns 'und')", () => {
    // Single short word; franc-min typically returns 'und' under minLength
    const r = detectLanguage("hi");
    if (r === null) return; // acceptable — caller treats as low confidence
    expect(r.confidence).toBe("low");
  });

  it("emits raw score for telemetry", () => {
    const r = detectLanguage(EN_SAMPLE);
    expect(typeof r?.score).toBe("number");
    expect(r?.score).toBeGreaterThan(0);
    expect(r?.score).toBeLessThanOrEqual(1);
  });
});

describe("resolveLanguage — Q4(c') fallback hierarchy", () => {
  const highEn: LanguageDetection = { language: "en", confidence: "high", score: 0.95 };
  const mediumFr: LanguageDetection = { language: "fr", confidence: "medium", score: 0.6 };
  const lowDe: LanguageDetection = { language: "de", confidence: "low", score: 0.3 };

  it("HIGH confidence detection → uses detected (ignores supported/default)", () => {
    expect(resolveLanguage(highEn, ["fr"], "fr")).toBe("en");
  });

  it("MEDIUM confidence + detected ∈ supportedLanguages → uses detected", () => {
    expect(resolveLanguage(mediumFr, ["en", "fr"], "en")).toBe("fr");
  });

  it("MEDIUM confidence + detected NOT in supportedLanguages → falls to default", () => {
    expect(resolveLanguage(mediumFr, ["en"], "en")).toBe("en");
  });

  it("LOW confidence → always falls to default (regardless of supported)", () => {
    expect(resolveLanguage(lowDe, ["de"], "en")).toBe("en");
  });

  it("null detection → uses defaultLanguage", () => {
    expect(resolveLanguage(null, ["en"], "fr")).toBe("fr");
  });

  it("null detection + null default → final fallback 'en'", () => {
    expect(resolveLanguage(null, null, null)).toBe("en");
  });

  it("undefined supportedLanguages + low confidence → defaultLanguage", () => {
    expect(resolveLanguage(lowDe, undefined, "es")).toBe("es");
  });
});
