// A clickable, numbered move list (1. e4 e5 2. Nf3 ...) shared between
// Play's history and Review's line-so-far -- same shape either way: an
// ordered list of SAN moves, one of which may be "the one you're looking
// at" and any of which may carry a quality signal.
export type MoveTone = 'good' | 'warn' | 'bad';

export interface MoveListView {
    // `activePly` is 1-indexed into `sans` (ply 1 = the first half-move);
    // null means nothing is highlighted (e.g. still at the start position).
    render(sans: readonly string[], activePly: number | null, tones?: readonly (MoveTone | undefined)[]): void;
}

export function createMoveList(container: HTMLElement, onSelect: (ply: number) => void): MoveListView {
    return {
        render(sans, activePly, tones) {
            container.innerHTML = '';
            for (let i = 0; i < sans.length; i += 2) {
                const row = document.createElement('span');
                row.className = 'move-row';

                const num = document.createElement('span');
                num.className = 'move-num';
                num.textContent = `${i / 2 + 1}.`;
                row.appendChild(num);

                row.appendChild(moveButton(sans[i], i + 1, activePly, tones?.[i]));
                if (sans[i + 1] !== undefined) {
                    row.appendChild(moveButton(sans[i + 1], i + 2, activePly, tones?.[i + 1]));
                }
                container.appendChild(row);
            }
        },
    };

    function moveButton(san: string, ply: number, activePly: number | null, tone: MoveTone | undefined): HTMLElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'move' + (ply === activePly ? ' active' : '') + (tone ? ` tone-${tone}` : '');
        btn.textContent = san;
        btn.addEventListener('click', () => onSelect(ply));
        return btn;
    }
}
