/**
 * Supported discovery countries — the source of truth for the Discover country
 * picker and the pre-dispatch guard in /api/discovery/run.
 *
 * MUST stay in sync with COUNTRY_CODES in tools/explorium_api.py. The pipeline
 * validates the country deep in a paid run (country_to_code); mirroring the list
 * here lets us reject an unsupported/misspelled name BEFORE spending any credits.
 * When the Python map changes, regenerate this file.
 *
 * COUNTRY_CODES holds every accepted spelling/alias (lowercased) so validation
 * exactly matches the pipeline. COUNTRY_NAMES is the curated one-per-country
 * display list shown in the datalist.
 */

/** name (lowercased) -> ISO-3166-alpha-2. Mirrors tools/explorium_api.py. */
export const COUNTRY_CODES: Record<string, string> = {
  // the 8 locked ICP countries (with aliases)
  spain: 'es',
  'united kingdom': 'gb', uk: 'gb', 'great britain': 'gb',
  england: 'gb', scotland: 'gb', wales: 'gb',
  italy: 'it',
  israel: 'il',
  germany: 'de',
  switzerland: 'ch',
  romania: 'ro',
  greece: 'gr',
  // broad set of common countries
  mexico: 'mx',
  portugal: 'pt',
  france: 'fr',
  netherlands: 'nl', 'the netherlands': 'nl', holland: 'nl',
  belgium: 'be',
  poland: 'pl',
  'united states': 'us', 'united states of america': 'us',
  usa: 'us', 'u.s.a.': 'us', 'u.s.': 'us', america: 'us',
  canada: 'ca',
  brazil: 'br',
  ireland: 'ie',
  austria: 'at',
  sweden: 'se',
  denmark: 'dk',
  norway: 'no',
  finland: 'fi',
  'czech republic': 'cz', czechia: 'cz',
  hungary: 'hu',
  turkey: 'tr', turkiye: 'tr', 'türkiye': 'tr',
  slovakia: 'sk',
  slovenia: 'si',
  croatia: 'hr',
  bulgaria: 'bg',
  serbia: 'rs',
  ukraine: 'ua',
  russia: 'ru',
  estonia: 'ee',
  latvia: 'lv',
  lithuania: 'lt',
  luxembourg: 'lu',
  iceland: 'is',
  cyprus: 'cy',
  malta: 'mt',
  argentina: 'ar',
  chile: 'cl',
  colombia: 'co',
  peru: 'pe',
  uruguay: 'uy',
  australia: 'au',
  'new zealand': 'nz',
  japan: 'jp',
  'south korea': 'kr', korea: 'kr',
  china: 'cn',
  india: 'in',
  indonesia: 'id',
  singapore: 'sg',
  malaysia: 'my',
  thailand: 'th',
  vietnam: 'vn',
  philippines: 'ph',
  'south africa': 'za',
  egypt: 'eg',
  morocco: 'ma',
  'saudi arabia': 'sa',
  'united arab emirates': 'ae', uae: 'ae',
  qatar: 'qa',
};

/** Curated one-per-country display names for the datalist (sorted). */
export const COUNTRY_NAMES: string[] = [
  'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Bulgaria',
  'Canada', 'Chile', 'China', 'Colombia', 'Croatia', 'Cyprus', 'Czech Republic',
  'Denmark', 'Egypt', 'Estonia', 'Finland', 'France', 'Germany', 'Greece',
  'Hungary', 'Iceland', 'India', 'Indonesia', 'Ireland', 'Israel', 'Italy',
  'Japan', 'Latvia', 'Lithuania', 'Luxembourg', 'Malaysia', 'Malta', 'Mexico',
  'Morocco', 'Netherlands', 'New Zealand', 'Norway', 'Peru', 'Philippines',
  'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Saudi Arabia', 'Serbia',
  'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain',
  'Sweden', 'Switzerland', 'Thailand', 'Turkey', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Vietnam',
];

/** Map an English country name to its ISO code, or null. Mirrors country_to_code. */
export function countryToCode(name: string | null | undefined): string | null {
  if (!name) return null;
  return COUNTRY_CODES[name.trim().toLowerCase()] ?? null;
}

/** True when the name is a country the pipeline can run (any accepted spelling). */
export function isSupportedCountry(name: string | null | undefined): boolean {
  return countryToCode(name) !== null;
}
