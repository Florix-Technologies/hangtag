// Tab bar icons of the app's modules (features/shop/services/modules.js). 24 × 24, stroked with the text colour.
const svg = (d, extra) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${extra || ""} aria-hidden="true">${d}</svg>`;

export const NAV_ICONS = {
  home: svg('<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>'),
  sell: svg('<path d="M5.5 8h13l-1.1 12.1a1 1 0 0 1-1 .9H7.6a1 1 0 0 1-1-.9z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>'),
  orders: svg('<path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5-2.5-1.5V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>'),
  stock: svg('<path d="M10 5.5a2 2 0 1 1 3 1.7c-.6.4-1 .9-1 1.6V10"/><path d="M12 10 3.4 16.3c-.8.6-.4 1.7.6 1.7h16c1 0 1.4-1.1.6-1.7z"/>'),
  products: svg('<path d="M8.5 4 3.5 6.6l1.8 4.1 2.2-.9V20h9V9.8l2.2.9 1.8-4.1-5-2.6c-.5 1.3-1.9 2.2-3.5 2.2S9 5.3 8.5 4z"/>'),
  customers: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>'),
  report: svg('<path d="M5 20v-8M10 20V5M15 20v-5M20 20V9"/>'),
  assistant: svg('<path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/><path d="M8 10h8M8 13.5h5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  tables: svg('<path d="M3.5 9h17M6 9v10M18 9v10M8 5h8"/>'),
  kitchen: svg('<path d="M6 11a4 4 0 1 1 3-6.6A4 4 0 0 1 18 11v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/><path d="M6 15h12"/>'),
  store: svg('<path d="M4 9.5 5.6 4.5h12.8L20 9.5"/><path d="M4 9.5h16v.7a2.9 2.9 0 0 1-5.3 1.6 2.9 2.9 0 0 1-5.4 0A2.9 2.9 0 0 1 4 10.2z"/><path d="M5.5 13v7h13v-7"/><path d="M10 20v-4h4v4"/>'),
  team: svg('<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><circle cx="12" cy="10" r="2.6"/><path d="M8 16.8a4 4 0 0 1 8 0"/>'),
  purchases: svg('<path d="M3 6.5h11v9H3z"/><path d="M14 9.5h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'),
  suppliers: svg('<path d="M3.5 20.5V10l5 3v-3l5 3V5.5h7v15z"/><path d="M3 20.5h18M16.5 9h1.5M16.5 12.5h1.5M16.5 16h1.5"/>'),
  pos: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4M8.5 9.5h7M8.5 13h7M8.5 16.5h4"/>'),
  tracking: svg('<path d="M4 6v12M7 6v12M10.5 6v12M13 6v12M16.5 6v12M20 6v12"/>'),
  count: svg('<path d="M9.5 6H20M9.5 12H20M9.5 18H20"/><path d="m3.5 6 1.3 1.3L7.2 5M3.5 12l1.3 1.3L7.2 11M3.5 18l1.3 1.3L7.2 17"/>'),
  smart: svg('<path d="M19.5 10.5A8 8 0 0 0 5.6 6.7L4 8.3"/><path d="M4 4.5v3.8h3.8"/><path d="M4.5 13.5a8 8 0 0 0 13.9 3.8l1.6-1.6"/><path d="M20 19.5v-3.8h-3.8"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  dot: svg('<circle cx="12" cy="12" r="3.5"/>'),
};
