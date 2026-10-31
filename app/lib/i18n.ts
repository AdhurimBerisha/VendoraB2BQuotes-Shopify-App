import { type i18n as I18n, createInstance } from "i18next";
import en from "../locales/en.json";

// Add "de", "fr", … here with their JSON files (order in roadmap/11).
const SUPPORTED = ["en"] as const;
const resources = { en: { translation: en } } as const;

// "pt-BR" exact if supported, else its base language ("de-CH" → "de"), else English.
const pickLocale = (input?: string | null): string => {
  const supported: readonly string[] = SUPPORTED;
  if (input && supported.includes(input)) return input;
  const base = input?.split("-")[0];
  return base && supported.includes(base) ? base : "en";
};

// One instance per render: resources are in memory, so init is synchronous (same text on server and client).
const createI18n = (locale: string): I18n => {
  const instance = createInstance();
  void instance.init({
    lng: pickLocale(locale),
    fallbackLng: "en",
    resources,
    initAsync: false,
    interpolation: { escapeValue: false }, // React escapes
  });
  return instance;
};

export { SUPPORTED, createI18n, pickLocale };
