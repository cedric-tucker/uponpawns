// Scattered, ephemeral glitch-text snippets that pop up at random spots
// within a container and fade away -- background "system noise" for the
// Home screen, distinct from the headline's own in-place repeating glitch.
import { applyGlitch } from './glitchtext';

const SNIPPETS = [
    'BLUNDER', 'MISTAKE', 'INACCURACY', 'BEST', 'TEMPO', 'FORK', 'PIN',
    'ZUGZWANG', 'TACTIC', 'CENTIPAWN', 'ANALYSE', 'REPEAT', 'PATTERN',
    'Nf3', 'Qxe5+', 'O-O', 'e4 e5', '+0.34', '-1.20', 'M4',
];

const SPAWN_DELAY_MIN_MS = 1400;
const SPAWN_DELAY_MAX_MS = 3200;
const HOLD_MS = 1600;
const FADE_MS = 400;

export function startAmbientGlitches(container: HTMLElement, finalFontFamily: string): () => void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return () => {}; // no popping/fading background text for reduced-motion users
    }

    let stopped = false;
    let timeoutId = 0;

    function scheduleNext(delay: number) {
        timeoutId = window.setTimeout(spawn, delay);
    }

    function spawn() {
        if (stopped) return;
        const el = document.createElement('span');
        el.className = 'home-ambient-glitch';
        el.style.left = `${6 + Math.random() * 78}%`;
        el.style.top = `${8 + Math.random() * 74}%`;
        container.appendChild(el);

        const text = SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)];
        applyGlitch(el, text, finalFontFamily).then(() => {
            if (stopped) {
                el.remove();
                return;
            }
            setTimeout(() => {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), FADE_MS);
            }, HOLD_MS);
        });

        scheduleNext(SPAWN_DELAY_MIN_MS + Math.random() * (SPAWN_DELAY_MAX_MS - SPAWN_DELAY_MIN_MS));
    }

    scheduleNext(800);
    return () => {
        stopped = true;
        clearTimeout(timeoutId);
    };
}
