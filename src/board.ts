import { Chessground } from "@lichess-org/chessground";
import type {Key, Dests, Color} from '@lichess-org/chessground/types';
import type { Api } from '@lichess-org/chessground/api';

export interface BoardView {
    render(state: {fen: string; turn: Color; dests: Dests}): void;
    setInteractive(enabled: boolean): void;
}

export function createBoard(
    board:HTMLElement,
    onMove:(orig: Key, dest: Key) => void,
): BoardView {
    const ground: Api = Chessground(board, {
        movable: {free: false, events: {after: onMove}},
    });
    return {
        render: ({fen, turn, dests}) =>{
            ground.set({fen, turnColor: turn, movable: {color:turn, dests}});
        },
        setInteractive: (enabled) => {
            ground.set({movable:{color:enabled ? undefined: 'white'}});
        },
    };
}