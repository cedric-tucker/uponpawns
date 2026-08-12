// Rules and position state. No DOM, no chessground -- this must never import
// board.ts. The board renders whatever this says is true; this never asks
// the board anything.
import { Chess } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSanAndPlay } from 'chessops/san';
import { parseUci } from 'chessops/util';
import type { Color, Move, NormalMove } from 'chessops/types';
import type { Position } from 'chessops/chess';

export interface Game {
    fen(): string;
    turn(): Color;
    position(): Position;
    isEnd(): boolean;
    outcome(): { winner: Color | undefined } | undefined;
    history(): readonly string[];
    /** FEN after `ply` half-moves (0 = the starting position this game was
     *  created with). Lets a viewer step through history without a second
     *  position of its own. */
    fenAt(ply: number): string;
    plyCount(): number;
    /** Pawn reaching the back rank needs a promotion role or chessops leaves an
     *  illegal pawn sitting on rank 1/8 -- this fills it in (auto-queen). */
    isPromotion(from: number, to: number): boolean;
    /** Whether `uci` is a legal move in the *current* position. chessops'
     *  play() trusts its caller and applies whatever it's given, so anything
     *  that plays a move sourced from outside the board's own dests() (a
     *  precomputed line, an engine reply computed for a since-diverged
     *  position, ...) needs to check this first or risk forcing an illegal
     *  move onto the board. */
    isLegalUci(uci: string): boolean;
    playSquares(from: number, to: number): string | undefined;
    playUci(uci: string): string | undefined;
    reset(): void;
    load(fen: string): void;
}

// Board, side to move, castling, en passant only -- halfmove clock and
// fullmove number don't affect evaluation but do differ between routes to
// the same position, so leaving them in a cache key causes misses and loses
// transposition hits.
export function normalizeFen(fen: string): string {
    return fen.split(' ').slice(0, 4).join(' ');
}

export function turnFromFen(fen: string): Color {
    return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function createGame(startFen?: string): Game {
    let pos: Position = startFen ? Chess.fromSetup(parseFen(startFen).unwrap()).unwrap() : Chess.default();
    let moves: string[] = [];
    let fens: string[] = [makeFen(pos.toSetup())];

    function isPromotion(from: number, to: number): boolean {
        const piece = pos.board.get(from);
        if (!piece || piece.role !== 'pawn') return false;
        const rank = to >> 3;
        return rank === 0 || rank === 7;
    }

    function play(move: Move): string {
        const san = makeSanAndPlay(pos, move);
        moves.push(san);
        fens.push(makeFen(pos.toSetup()));
        return san;
    }

    return {
        fen: () => makeFen(pos.toSetup()),
        turn: () => pos.turn,
        position: () => pos,
        isEnd: () => pos.isEnd(),
        outcome: () => pos.outcome(),
        history: () => moves,
        fenAt: (ply) => fens[ply] ?? fens[fens.length - 1],
        plyCount: () => moves.length,
        isPromotion,
        isLegalUci: (uci) => {
            const move = parseUci(uci);
            return move !== undefined && pos.isLegal(move);
        },
        playSquares: (from, to) => {
            const move: NormalMove = { from, to, promotion: isPromotion(from, to) ? 'queen' : undefined };
            return play(move);
        },
        playUci: (uci) => {
            const move = parseUci(uci);
            if (!move) return undefined;
            return play(move);
        },
        reset: () => {
            pos = Chess.default();
            moves = [];
            fens = [makeFen(pos.toSetup())];
        },
        load: (fen) => {
            pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
            moves = [];
            fens = [makeFen(pos.toSetup())];
        },
    };
}
