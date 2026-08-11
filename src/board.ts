import { Chessground } from "@lichess-org/chessground";
import type {Key, Dests, Color} from '@lichess-org/chessground/types';
import type { Api } from '@lichess-org/chessground/api';

export interface BoardView {
    render(state: {fen: string; turn: Color; dests: Dests; interactive: boolean}): void;
    // `fraction` is White's share of the bar in [0, 1]; `null` hides it.
    // The board doesn't know what centipawns mean -- that mapping happens
    // upstream -- it just paints whatever fraction it's handed.
    renderEval(fraction: number | null): void;
}

export function createBoard(
    board:HTMLElement,
    onMove:(orig: Key, dest: Key) => void,
): BoardView {
    const ground: Api = Chessground(board, {
        movable: {free: false, events: {after: onMove}},
    });

    const evalBar = document.getElementById('eval-bar');
    const evalFill = document.getElementById('eval-fill');

    return {
        // Single path for board state: interactivity is just "does this render
        // carry live dests", not a separate mode toggled elsewhere. Chessground
        // only allows drags when movable.color matches the piece's color, so
        // "not interactive" means no color and no dests -- not `color: undefined`
        // with dests left dangling, which silently blocks every drag.
        render: ({fen, turn, dests, interactive}) => {
            ground.set({
                fen,
                turnColor: turn,
                movable: {
                    color: interactive ? turn : undefined,
                    dests: interactive ? dests : new Map(),
                },
            });
        },
        renderEval: (fraction) => {
            if (!evalBar || !evalFill) return;
            evalBar.classList.toggle('visible', fraction !== null);
            if (fraction !== null) {
                evalFill.style.height = `${fraction * 100}%`;
            }
        },
    };
}
