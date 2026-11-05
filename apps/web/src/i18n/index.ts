import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './de.json';

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

function initialLanguage(): Language {
  const stored = (() => {
    try {
      return localStorage.getItem('mh-lang');
    } catch {
      return null;
    }
  })();
  if (stored === 'de' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** German is built in (it is also the fallback); English is loaded the first time someone needs it. */
const loaded = new Set<Language>(['de']);
export async function ensureLanguage(language: Language): Promise<void> {
  if (loaded.has(language)) return;
  const { default: texts } = await import('./en.json');
  i18n.addResourceBundle(language, 'translation', texts, true, true);
  loaded.add(language);
}

const firstLanguage = initialLanguage();
void i18n.use(initReactI18next).init({
  resources: { de: { translation: de } },
  lng: 'de',
  // No advertising line from i18next in the browser console.
  showSupportNotice: false,
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
  returnNull: false,
  // Option values such as "minecraft:flat" contain colons; there is only one namespace.
  nsSeparator: false,
});

if (firstLanguage !== 'de') void ensureLanguage(firstLanguage).then(() => i18n.changeLanguage(firstLanguage));

export function setLanguage(language: Language): void {
  void ensureLanguage(language).then(() => i18n.changeLanguage(language));
  document.documentElement.lang = language;
  try {
    localStorage.setItem('mh-lang', language);
  } catch {
    // Private windows may refuse storage; the language still applies to this visit.
  }
}

export default i18n;
