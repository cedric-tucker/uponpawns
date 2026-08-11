// A draggable corner handle that resizes a board by writing a shared CSS
// custom property, persisted across sessions. One preference for both
// boards (Play and Review) since there's no reason they'd want to differ.
const STORAGE_KEY = 'uponpawns:boardSize';
const MIN_SIZE = 260;
const MAX_SIZE = 760;
const PROPERTY = '--board-size';

function clamp(value: number): number {
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, value));
}

// Applied once at startup so a returning visitor's chosen size is there
// before the first board render.
export function initBoardSize(): void {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) document.documentElement.style.setProperty(PROPERTY, stored);
}

export function makeResizable(target: HTMLElement, handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startSize = target.getBoundingClientRect().width;
        handle.setPointerCapture(e.pointerId);

        const onMove = (ev: PointerEvent) => {
            const size = clamp(startSize + (ev.clientX - startX));
            document.documentElement.style.setProperty(PROPERTY, `${size}px`);
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            const size = document.documentElement.style.getPropertyValue(PROPERTY);
            if (size) localStorage.setItem(STORAGE_KEY, size);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    });
}
