import { Chessground } from "@lichess-org/chessground";
import type {Key, Dests, Color} from '@lichess-org/chessground/types';
import type { Api } from '@lichess-org/chessground/api';

export interface BoardView {
    render(state: {fen: string; turn: Color; dests: Dests; interactive: boolean; orientation: Color}): void;
    // `fraction` is White's share of the bar in [0, 1]; `null` hides it.
    // The board doesn't know what centipawns mean -- that mapping happens
    // upstream -- it just paints whatever fraction it's handed.
    renderEval(fraction: number | null): void;
    // Draws an arrow for a move without playing it -- used for "show me the
    // right move" on a failed review. Cleared automatically on the next
    // render() so a stale hint never survives a position change.
    showHint(orig: Key, dest: Key): void;
}

// Fixed regardless of light/dark theme (the board itself doesn't change
// with the app's theme -- see style.css), so the hint arrow is fixed too
// rather than reading a CSS custom property chessground can't see anyway.
const HINT_COLOR = '#2e6b63';

export function createBoard(
    board:HTMLElement,
    onMove:(orig: Key, dest: Key) => void,
): BoardView {
    const ground: Api = Chessground(board, {
        movable: {free: false, events: {after: onMove}},
        drawable: {
            brushes: {
                green: { key: 'g', color: HINT_COLOR, opacity: 0.9, lineWidth: 10 },
                red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
                blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
                yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
            },
        },
    });

    const evalBar = document.getElementById('eval-bar');
    const evalFill = document.getElementById('eval-fill');

    return {
        // Single path for board state: interactivity is just "does this render
        // carry live dests", not a separate mode toggled elsewhere. Chessground
        // only allows drags when movable.color matches the piece's color, so
        // "not interactive" means no color and no dests -- not `color: undefined`
        // with dests left dangling, which silently blocks every drag.
        render: ({fen, turn, dests, interactive, orientation}) => {
            ground.set({
                fen,
                turnColor: turn,
                orientation,
                movable: {
                    color: interactive ? turn : undefined,
                    dests: interactive ? dests : new Map(),
                },
                drawable: { autoShapes: [] },
            });
        },
        renderEval: (fraction) => {
            if (!evalBar || !evalFill) return;
            evalBar.classList.toggle('visible', fraction !== null);
            if (fraction !== null) {
                evalFill.style.height = `${fraction * 100}%`;
            }
        },
        showHint: (orig, dest) => {
            ground.set({ drawable: { autoShapes: [{ orig, dest, brush: 'green' }] } });
        },
    };
}
