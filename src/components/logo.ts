/** Original Om-inspired Mishrin mark (stroke paths, no font dependency). */
export const LOGO_PATHS = `<circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/>
<path d="M27 38c10-9 24-4 20 6-2 5-8 7-12 7 9 0 17 4 15 13-2 9-14 11-21 5" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M47 52c8-6 20-4 22 6 2 9-5 16-12 14" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
<path d="M69 58c4-8 10-12 14-11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
<path d="M50 30c6 6 18 6 24 0" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
<circle cx="62" cy="20" r="4" fill="currentColor"/>`;

export const logo = (cls = 'logo') => `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">${LOGO_PATHS}</svg>`;
