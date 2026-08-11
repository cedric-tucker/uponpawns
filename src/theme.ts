// Explicit light/dark choice, persisted. The *first paint* theme is applied
// by a tiny inline script in index.html (before any module loads, so there's
// no flash) using the same storage key -- this module is what the toggle
// button in the UI talks to afterward, reading back whatever that script
// (or a previous toggle) already stamped onto <html data-theme>.
const STORAGE_KEY = 'uponpawns:theme';

export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(STORAGE_KEY, next);
    return next;
}
