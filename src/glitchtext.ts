// Cycles each letter of a text node through a few different font-faces
// before settling on the real one -- the letters themselves never change,
// only the face they're rendered in, so it reads as a glitch rather than a
// decrypt/assemble effect. Repeats on a pause, not just once on load.
const GLITCH_FONTS = [
    'ui-monospace, monospace',
    'Georgia, serif',
    '"Arial Black", sans-serif',
    '"Courier New", monospace',
];

const CYCLES_PER_LETTER = 5;
const CYCLE_MS = 65;
const STAGGER_MS = 35;
const REPEAT_PAUSE_MS = 3500; // quiet time between glitch passes

export function glitchText(el: HTMLElement, finalFontFamily: string): void {
    const text = el.textContent ?? '';

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.style.fontFamily = finalFontFamily;
        return;
    }

    el.textContent = '';
    el.setAttribute('aria-label', text);
    const spans = [...text].map((ch) => {
        const span = document.createElement('span');
        span.textContent = ch;
        span.style.display = 'inline-block';
        span.setAttribute('aria-hidden', 'true');
        el.appendChild(span);
        return span;
    });

    function runPass() {
        spans.forEach((span, i) => {
            if (text[i] === ' ') return;
            let count = 0;
            setTimeout(() => {
                const interval = setInterval(() => {
                    span.style.fontFamily = GLITCH_FONTS[count % GLITCH_FONTS.length];
                    count++;
                    if (count >= CYCLES_PER_LETTER) {
                        clearInterval(interval);
                        span.style.fontFamily = finalFontFamily;
                    }
                }, CYCLE_MS);
            }, i * STAGGER_MS);
        });

        const passDuration = text.length * STAGGER_MS + CYCLES_PER_LETTER * CYCLE_MS;
        setTimeout(runPass, passDuration + REPEAT_PAUSE_MS);
    }

    runPass();
}
