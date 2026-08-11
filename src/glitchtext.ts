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

export function glitchText(el: HTMLElement, finalFontFamily: string): void {
    const text = el.textContent ?? '';

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.style.fontFamily = finalFontFamily;
        return;
    }

    const cycles = 5;
    const cycleMs = 65;
    const staggerMs = 35;

    el.textContent = '';
    el.setAttribute('aria-label', text);
    [...text].forEach((ch, i) => {
        const span = document.createElement('span');
        span.textContent = ch;
        span.style.display = 'inline-block';
        span.setAttribute('aria-hidden', 'true');
        el.appendChild(span);
        if (ch === ' ') return;

        let count = 0;
        setTimeout(() => {
            const interval = setInterval(() => {
                span.style.fontFamily = GLITCH_FONTS[count % GLITCH_FONTS.length];
                count++;
                if (count >= cycles) {
                    clearInterval(interval);
                    span.style.fontFamily = finalFontFamily;
                }
            }, cycleMs);
        }, i * staggerMs);
    });
}
