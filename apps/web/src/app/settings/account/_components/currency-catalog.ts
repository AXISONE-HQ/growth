/**
 * KAN-859 — ISO 4217 currency catalog. Grouped by region per Fred's
 * Decision 4: "regional grouping helps the AdditionalCurrenciesMultiSelect
 * use case (user adds currencies for a market they want to expand into —
 * browsing by region beats alphabetical for that intent)."
 *
 * Display label format (per Fred Decision Nit): `"USD — US Dollar ($)"`
 * — code first (it's what's stored), symbol parenthetical for recognition.
 *
 * Coverage: ~150 mainstream entries. Ultra-obscure / discontinued codes
 * intentionally omitted; any tenant who needs one can have it added on
 * request rather than burying every option in the picker.
 */

export type CurrencyRegion =
  | "Americas"
  | "Europe"
  | "Asia-Pacific"
  | "Middle East & Africa";

export interface Currency {
  code: string; // ISO 4217 (3 uppercase letters)
  name: string;
  symbol: string;
  region: CurrencyRegion;
}

export const AMERICAS_CURRENCIES: readonly Currency[] = [
  { code: "USD", name: "US Dollar", symbol: "$", region: "Americas" },
  { code: "CAD", name: "Canadian Dollar", symbol: "$", region: "Americas" },
  { code: "MXN", name: "Mexican Peso", symbol: "$", region: "Americas" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$", region: "Americas" },
  { code: "ARS", name: "Argentine Peso", symbol: "$", region: "Americas" },
  { code: "CLP", name: "Chilean Peso", symbol: "$", region: "Americas" },
  { code: "COP", name: "Colombian Peso", symbol: "$", region: "Americas" },
  { code: "PEN", name: "Peruvian Sol", symbol: "S/", region: "Americas" },
  { code: "UYU", name: "Uruguayan Peso", symbol: "$", region: "Americas" },
  { code: "VES", name: "Venezuelan Bolívar", symbol: "Bs.", region: "Americas" },
  { code: "GTQ", name: "Guatemalan Quetzal", symbol: "Q", region: "Americas" },
  { code: "HNL", name: "Honduran Lempira", symbol: "L", region: "Americas" },
  { code: "NIO", name: "Nicaraguan Córdoba", symbol: "C$", region: "Americas" },
  { code: "CRC", name: "Costa Rican Colón", symbol: "₡", region: "Americas" },
  { code: "DOP", name: "Dominican Peso", symbol: "$", region: "Americas" },
  { code: "PYG", name: "Paraguayan Guaraní", symbol: "₲", region: "Americas" },
  { code: "BOB", name: "Bolivian Boliviano", symbol: "Bs.", region: "Americas" },
  { code: "HTG", name: "Haitian Gourde", symbol: "G", region: "Americas" },
  { code: "JMD", name: "Jamaican Dollar", symbol: "$", region: "Americas" },
  { code: "TTD", name: "Trinidad and Tobago Dollar", symbol: "$", region: "Americas" },
  { code: "BBD", name: "Barbadian Dollar", symbol: "$", region: "Americas" },
  { code: "BSD", name: "Bahamian Dollar", symbol: "$", region: "Americas" },
  { code: "BZD", name: "Belize Dollar", symbol: "BZ$", region: "Americas" },
  { code: "BMD", name: "Bermudian Dollar", symbol: "$", region: "Americas" },
  { code: "KYD", name: "Cayman Islands Dollar", symbol: "$", region: "Americas" },
  { code: "XCD", name: "East Caribbean Dollar", symbol: "$", region: "Americas" },
  { code: "ANG", name: "Netherlands Antillean Guilder", symbol: "ƒ", region: "Americas" },
  { code: "AWG", name: "Aruban Florin", symbol: "ƒ", region: "Americas" },
  { code: "SRD", name: "Surinamese Dollar", symbol: "$", region: "Americas" },
  { code: "GYD", name: "Guyanese Dollar", symbol: "$", region: "Americas" },
  { code: "CUP", name: "Cuban Peso", symbol: "$", region: "Americas" },
];

export const EUROPE_CURRENCIES: readonly Currency[] = [
  { code: "EUR", name: "Euro", symbol: "€", region: "Europe" },
  { code: "GBP", name: "British Pound", symbol: "£", region: "Europe" },
  { code: "CHF", name: "Swiss Franc", symbol: "Fr.", region: "Europe" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr", region: "Europe" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr", region: "Europe" },
  { code: "DKK", name: "Danish Krone", symbol: "kr", region: "Europe" },
  { code: "ISK", name: "Icelandic Króna", symbol: "kr", region: "Europe" },
  { code: "PLN", name: "Polish Złoty", symbol: "zł", region: "Europe" },
  { code: "CZK", name: "Czech Koruna", symbol: "Kč", region: "Europe" },
  { code: "HUF", name: "Hungarian Forint", symbol: "Ft", region: "Europe" },
  { code: "RON", name: "Romanian Leu", symbol: "lei", region: "Europe" },
  { code: "BGN", name: "Bulgarian Lev", symbol: "лв", region: "Europe" },
  { code: "RSD", name: "Serbian Dinar", symbol: "дин.", region: "Europe" },
  { code: "MKD", name: "Macedonian Denar", symbol: "ден", region: "Europe" },
  { code: "ALL", name: "Albanian Lek", symbol: "L", region: "Europe" },
  { code: "BAM", name: "Bosnia-Herzegovina Convertible Mark", symbol: "KM", region: "Europe" },
  { code: "MDL", name: "Moldovan Leu", symbol: "L", region: "Europe" },
  { code: "UAH", name: "Ukrainian Hryvnia", symbol: "₴", region: "Europe" },
  { code: "RUB", name: "Russian Ruble", symbol: "₽", region: "Europe" },
  { code: "BYN", name: "Belarusian Ruble", symbol: "Br", region: "Europe" },
  { code: "GEL", name: "Georgian Lari", symbol: "₾", region: "Europe" },
  { code: "AMD", name: "Armenian Dram", symbol: "֏", region: "Europe" },
  { code: "AZN", name: "Azerbaijani Manat", symbol: "₼", region: "Europe" },
  { code: "TRY", name: "Turkish Lira", symbol: "₺", region: "Europe" },
];

export const ASIA_PACIFIC_CURRENCIES: readonly Currency[] = [
  { code: "JPY", name: "Japanese Yen", symbol: "¥", region: "Asia-Pacific" },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥", region: "Asia-Pacific" },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "KRW", name: "South Korean Won", symbol: "₩", region: "Asia-Pacific" },
  { code: "TWD", name: "New Taiwan Dollar", symbol: "NT$", region: "Asia-Pacific" },
  { code: "INR", name: "Indian Rupee", symbol: "₹", region: "Asia-Pacific" },
  { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp", region: "Asia-Pacific" },
  { code: "THB", name: "Thai Baht", symbol: "฿", region: "Asia-Pacific" },
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM", region: "Asia-Pacific" },
  { code: "PHP", name: "Philippine Peso", symbol: "₱", region: "Asia-Pacific" },
  { code: "VND", name: "Vietnamese Đồng", symbol: "₫", region: "Asia-Pacific" },
  { code: "SGD", name: "Singapore Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "AUD", name: "Australian Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "NZD", name: "New Zealand Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "FJD", name: "Fijian Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "PGK", name: "Papua New Guinean Kina", symbol: "K", region: "Asia-Pacific" },
  { code: "SBD", name: "Solomon Islands Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "TOP", name: "Tongan Paʻanga", symbol: "T$", region: "Asia-Pacific" },
  { code: "VUV", name: "Vanuatu Vatu", symbol: "VT", region: "Asia-Pacific" },
  { code: "WST", name: "Samoan Tala", symbol: "WS$", region: "Asia-Pacific" },
  { code: "BND", name: "Brunei Dollar", symbol: "$", region: "Asia-Pacific" },
  { code: "KHR", name: "Cambodian Riel", symbol: "៛", region: "Asia-Pacific" },
  { code: "LAK", name: "Laotian Kip", symbol: "₭", region: "Asia-Pacific" },
  { code: "MMK", name: "Myanmar Kyat", symbol: "K", region: "Asia-Pacific" },
  { code: "NPR", name: "Nepalese Rupee", symbol: "Rs", region: "Asia-Pacific" },
  { code: "BTN", name: "Bhutanese Ngultrum", symbol: "Nu.", region: "Asia-Pacific" },
  { code: "BDT", name: "Bangladeshi Taka", symbol: "৳", region: "Asia-Pacific" },
  { code: "PKR", name: "Pakistani Rupee", symbol: "Rs", region: "Asia-Pacific" },
  { code: "LKR", name: "Sri Lankan Rupee", symbol: "Rs", region: "Asia-Pacific" },
  { code: "AFN", name: "Afghan Afghani", symbol: "؋", region: "Asia-Pacific" },
  { code: "MOP", name: "Macanese Pataca", symbol: "MOP$", region: "Asia-Pacific" },
  { code: "MNT", name: "Mongolian Tögrög", symbol: "₮", region: "Asia-Pacific" },
  { code: "KZT", name: "Kazakhstani Tenge", symbol: "₸", region: "Asia-Pacific" },
  { code: "KGS", name: "Kyrgyzstani Som", symbol: "с", region: "Asia-Pacific" },
  { code: "TJS", name: "Tajikistani Somoni", symbol: "SM", region: "Asia-Pacific" },
  { code: "TMT", name: "Turkmenistani Manat", symbol: "T", region: "Asia-Pacific" },
  { code: "UZS", name: "Uzbekistani Som", symbol: "лв", region: "Asia-Pacific" },
  { code: "XPF", name: "CFP Franc", symbol: "₣", region: "Asia-Pacific" },
];

export const MEA_CURRENCIES: readonly Currency[] = [
  { code: "AED", name: "UAE Dirham", symbol: "د.إ", region: "Middle East & Africa" },
  { code: "SAR", name: "Saudi Riyal", symbol: "ر.س", region: "Middle East & Africa" },
  { code: "ILS", name: "Israeli New Shekel", symbol: "₪", region: "Middle East & Africa" },
  { code: "ZAR", name: "South African Rand", symbol: "R", region: "Middle East & Africa" },
  { code: "EGP", name: "Egyptian Pound", symbol: "£", region: "Middle East & Africa" },
  { code: "NGN", name: "Nigerian Naira", symbol: "₦", region: "Middle East & Africa" },
  { code: "KES", name: "Kenyan Shilling", symbol: "KSh", region: "Middle East & Africa" },
  { code: "GHS", name: "Ghanaian Cedi", symbol: "₵", region: "Middle East & Africa" },
  { code: "MAD", name: "Moroccan Dirham", symbol: "د.م.", region: "Middle East & Africa" },
  { code: "DZD", name: "Algerian Dinar", symbol: "د.ج", region: "Middle East & Africa" },
  { code: "TND", name: "Tunisian Dinar", symbol: "د.ت", region: "Middle East & Africa" },
  { code: "LYD", name: "Libyan Dinar", symbol: "ل.د", region: "Middle East & Africa" },
  { code: "IQD", name: "Iraqi Dinar", symbol: "ع.د", region: "Middle East & Africa" },
  { code: "JOD", name: "Jordanian Dinar", symbol: "د.ا", region: "Middle East & Africa" },
  { code: "KWD", name: "Kuwaiti Dinar", symbol: "د.ك", region: "Middle East & Africa" },
  { code: "QAR", name: "Qatari Riyal", symbol: "ر.ق", region: "Middle East & Africa" },
  { code: "OMR", name: "Omani Rial", symbol: "ر.ع.", region: "Middle East & Africa" },
  { code: "BHD", name: "Bahraini Dinar", symbol: ".د.ب", region: "Middle East & Africa" },
  { code: "LBP", name: "Lebanese Pound", symbol: "ل.ل", region: "Middle East & Africa" },
  { code: "YER", name: "Yemeni Rial", symbol: "ر.ي", region: "Middle East & Africa" },
  { code: "SYP", name: "Syrian Pound", symbol: "£", region: "Middle East & Africa" },
  { code: "IRR", name: "Iranian Rial", symbol: "ر", region: "Middle East & Africa" },
  { code: "ETB", name: "Ethiopian Birr", symbol: "Br", region: "Middle East & Africa" },
  { code: "UGX", name: "Ugandan Shilling", symbol: "USh", region: "Middle East & Africa" },
  { code: "TZS", name: "Tanzanian Shilling", symbol: "TSh", region: "Middle East & Africa" },
  { code: "RWF", name: "Rwandan Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "BIF", name: "Burundian Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "DJF", name: "Djiboutian Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "ERN", name: "Eritrean Nakfa", symbol: "Nfk", region: "Middle East & Africa" },
  { code: "SOS", name: "Somali Shilling", symbol: "S", region: "Middle East & Africa" },
  { code: "SDG", name: "Sudanese Pound", symbol: "ج.س.", region: "Middle East & Africa" },
  { code: "SSP", name: "South Sudanese Pound", symbol: "£", region: "Middle East & Africa" },
  { code: "MWK", name: "Malawian Kwacha", symbol: "MK", region: "Middle East & Africa" },
  { code: "ZMW", name: "Zambian Kwacha", symbol: "ZK", region: "Middle East & Africa" },
  { code: "ZWL", name: "Zimbabwean Dollar", symbol: "$", region: "Middle East & Africa" },
  { code: "BWP", name: "Botswanan Pula", symbol: "P", region: "Middle East & Africa" },
  { code: "NAD", name: "Namibian Dollar", symbol: "$", region: "Middle East & Africa" },
  { code: "LSL", name: "Lesotho Loti", symbol: "L", region: "Middle East & Africa" },
  { code: "SZL", name: "Swazi Lilangeni", symbol: "E", region: "Middle East & Africa" },
  { code: "MZN", name: "Mozambican Metical", symbol: "MT", region: "Middle East & Africa" },
  { code: "MGA", name: "Malagasy Ariary", symbol: "Ar", region: "Middle East & Africa" },
  { code: "MUR", name: "Mauritian Rupee", symbol: "₨", region: "Middle East & Africa" },
  { code: "SCR", name: "Seychellois Rupee", symbol: "₨", region: "Middle East & Africa" },
  { code: "CDF", name: "Congolese Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "XAF", name: "Central African CFA Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "XOF", name: "West African CFA Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "KMF", name: "Comorian Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "AOA", name: "Angolan Kwanza", symbol: "Kz", region: "Middle East & Africa" },
  { code: "GMD", name: "Gambian Dalasi", symbol: "D", region: "Middle East & Africa" },
  { code: "GNF", name: "Guinean Franc", symbol: "₣", region: "Middle East & Africa" },
  { code: "LRD", name: "Liberian Dollar", symbol: "$", region: "Middle East & Africa" },
  { code: "SLL", name: "Sierra Leonean Leone", symbol: "Le", region: "Middle East & Africa" },
  { code: "STN", name: "São Tomé & Príncipe Dobra", symbol: "Db", region: "Middle East & Africa" },
  { code: "CVE", name: "Cape Verdean Escudo", symbol: "$", region: "Middle East & Africa" },
  { code: "MRU", name: "Mauritanian Ouguiya", symbol: "UM", region: "Middle East & Africa" },
];

export const ALL_CURRENCIES: readonly Currency[] = [
  ...AMERICAS_CURRENCIES,
  ...EUROPE_CURRENCIES,
  ...ASIA_PACIFIC_CURRENCIES,
  ...MEA_CURRENCIES,
];

export const CURRENCIES_BY_CODE: ReadonlyMap<string, Currency> = new Map(
  ALL_CURRENCIES.map((c) => [c.code, c]),
);

export const CURRENCY_REGIONS_ORDERED: readonly CurrencyRegion[] = [
  "Americas",
  "Europe",
  "Asia-Pacific",
  "Middle East & Africa",
];

export const CURRENCIES_BY_REGION: ReadonlyMap<CurrencyRegion, readonly Currency[]> =
  new Map([
    ["Americas", AMERICAS_CURRENCIES],
    ["Europe", EUROPE_CURRENCIES],
    ["Asia-Pacific", ASIA_PACIFIC_CURRENCIES],
    ["Middle East & Africa", MEA_CURRENCIES],
  ]);

/** Format for the Select option label per Fred's display-format Decision:
 * `"USD — US Dollar ($)"`. */
export function formatCurrencyOption(c: Currency): string {
  return `${c.code} — ${c.name} (${c.symbol})`;
}

export function isValidCurrencyCode(code: string): boolean {
  return CURRENCIES_BY_CODE.has(code);
}
