// Cycles each letter of a text node through a few different font-faces
// before settling on the real one -- the letters themselves never change,
// only the face they're rendered in, so it reads as a glitch rather than a
// decrypt/assemble effect.
const GLITCH_FONTS = [
    'ui-monospace, monospace',
    'Georgia, serif',
    '"Arial Black", sans-serif',
    '"Courier New", monospace',
];

const CYCLES_PER_LETTER = 5;
const CYCLE_MS = 65;
const STAGGER_MS = 35;
const REPEAT_PAUSE_MS = 3500; // quiet time between the headline's glitch passes

function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// One glitch pass on `el`, replacing its content with `text` letter by
// letter. Resolves once every letter has settled on `finalFontFamily`.
// Exported so ephemeral, randomly-placed snippets (ambientglitch.ts) can
// reuse the same effect instead of duplicating the cycling logic.
export function applyGlitch(el: HTMLElement, text: string, finalFontFamily: string): Promise<void> {
    return new Promise((resolve) => {
        if (reducedMotion()) {
            el.textContent = text;
            el.style.fontFamily = finalFontFamily;
            resolve();
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

        let remaining = [...text].filter((ch) => ch !== ' ').length;
        if (remaining === 0) {
            resolve();
            return;
        }

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
                        remaining--;
                        if (remaining === 0) resolve();
                    }
                }, CYCLE_MS);
            }, i * STAGGER_MS);
        });
    });
}

// The headline: glitches its existing text in place, on a repeating loop.
export function glitchText(el: HTMLElement, finalFontFamily: string): void {
    const text = el.textContent ?? '';
    function loop() {
        applyGlitch(el, text, finalFontFamily).then(() => {
            setTimeout(loop, REPEAT_PAUSE_MS);
        });
    }
    loop();
}
