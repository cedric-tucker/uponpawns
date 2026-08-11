// PGN import: walk a game, evaluate every position, flag the moments the
// user dropped an advantage or missed a win, and turn those into cards.
//
// Two passes, matching two different engine budgets (see the spec's Engine
// policy): a cheap single-PV scan at SCAN_DEPTH across every ply to find
// the blunders, then a deep MultiPV pass at DEEP_DEPTH -- only on the
// flagged spots -- to build out the correct line, alternatives, and
// precomputed wrong-branch evals that make review fast later.
import { Chess } from 'chessops/chess';
import type { Position } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { parseUci } from 'chessops/util';
import type { Color } from 'chessops/types';

import type { AnalyzeOptions, Engine, Score } from './engine';
import { normalizeFen } from './game';
import type { AlternativeLine, Card } from './review';
import { newFsrsState, evalDrop } from './review';
import type { Store } from './store';

export const SCAN_DEPTH = 14;
export const DEEP_DEPTH = 22;
export const DEEP_MULTIPV = 3;
// Flag anything Hard-or-worse (see the grading table) as worth a card.
export const BLUNDER_THRESHOLD_CP = 100;
// Open question in the spec: how many plies is "the correct continuation"?
// Fixed count for now, decided per-card at import time as suggested there.
export const CORRECT_LINE_PLIES = 6;

export interface ImportOptions {
    // Which side you're studying. A blunder by this side becomes a card at
    // the position *before* the mistake (find the move you missed); a
    // blunder by the other side becomes a card at the position *after* it
    // (find how to punish it) -- either way the card's side-to-move is
    // always studySide, since that's the only color you'll ever be asked
    // to play in review.
    studySide: Color;
    // Off by default: most of the time you want to drill your own misses,
    // not build a whole second collection out of every mistake the
    // opponent made.
    includeOpponentBlunders: boolean;
}

export interface ImportProgress {
    phase: 'scan' | 'deepen';
    current: number;
    total: number;
    detail: string;
}

export interface ImportResult {
    gameId: string;
    plies: number;
    cardsCreated: number;
    cardsSkipped: number;
}

interface FlaggedSpot {
    fen: string; // normalised; side to move here is always options.studySide
    moveNumber: number;
    evalBefore: Score;
    evalAfter: Score;
}

async function evalOnly(engine: Engine, fen: string, options: AnalyzeOptions): Promise<Score | undefined> {
    const result = await engine.analyze(fen, options);
    return result.lines[0]?.score;
}

// Walks `pv` from `rootFen`, evaluating and caching every resulting
// position. This is what lets review-time stay on the ~1s (or cache-hit)
// budget for anything on the line the user is expected to play.
async function precomputeLine(engine: Engine, rootFen: string, pv: string[], out: Record<string, Score>): Promise<void> {
    let pos: Position = Chess.fromSetup(parseFen(rootFen).unwrap()).unwrap();
    for (const uci of pv) {
        const move = parseUci(uci);
        if (!move) break;
        pos.play(move);
        if (pos.isEnd()) break;
        const fen = makeFen(pos.toSetup());
        const key = normalizeFen(fen);
        if (!(key in out)) {
            const score = await evalOnly(engine, fen, { depth: SCAN_DEPTH, multiPv: 1 });
            if (score) out[key] = score;
        }
    }
}

// One ply of a plausible-but-wrong branch: the cache misses exactly when it
// hurts (the user played something other than the line), so precompute the
// engine's other top candidates defensively.
async function precomputeBranch(engine: Engine, rootFen: string, uciMove: string, out: Record<string, Score>): Promise<void> {
    const move = parseUci(uciMove);
    if (!move) return;
    const pos: Position = Chess.fromSetup(parseFen(rootFen).unwrap()).unwrap();
    pos.play(move);
    if (pos.isEnd()) return;
    const fen = makeFen(pos.toSetup());
    const key = normalizeFen(fen);
    if (key in out) return;
    const score = await evalOnly(engine, fen, { depth: SCAN_DEPTH, multiPv: 1 });
    if (score) out[key] = score;
}

// Exported so manual FEN entry (spec step 8) can build a card the same way
// import does, without needing a scan-pass eval of its own -- when
// evalBefore/evalAfter aren't supplied, both just fall back to the deep
// pass's own score, since there's no "played move" to compare against.
export async function buildCard(
    engine: Engine,
    fen: string,
    sideToMove: Color,
    sourceGame: string,
    moveNumber: number,
    evalBefore?: Score,
    evalAfter?: Score,
): Promise<Card> {
    const deep = await engine.analyze(fen, { depth: DEEP_DEPTH, multiPv: DEEP_MULTIPV });
    const mainLine = deep.lines[0];
    const resolvedEval: Score = mainLine?.score ?? { type: 'cp', value: 0 };
    const alternatives: AlternativeLine[] = deep.lines.map((l) => ({ move: l.pv[0], score: l.score, pv: l.pv }));

    const precomputed: Record<string, Score> = {};
    if (mainLine) await precomputeLine(engine, fen, mainLine.pv.slice(0, CORRECT_LINE_PLIES), precomputed);
    for (const alt of deep.lines.slice(1)) {
        if (alt.pv[0]) await precomputeBranch(engine, fen, alt.pv[0], precomputed);
    }

    return {
        id: crypto.randomUUID(),
        fen,
        sideToMove,
        sourceGame,
        moveNumber,
        evalBefore: evalBefore ?? resolvedEval,
        evalAfter: evalAfter ?? resolvedEval,
        correctLine: (mainLine?.pv ?? []).slice(0, CORRECT_LINE_PLIES),
        alternatives,
        precomputed,
        fsrs: newFsrsState(new Date()),
        history: [],
    };
}

export async function importPgn(
    pgn: string,
    engine: Engine,
    store: Store,
    options: ImportOptions,
    onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
    const games = parsePgn(pgn);
    if (games.length === 0) throw new Error('No games found in PGN');
    const game = games[0];

    const headers: Record<string, string> = {};
    for (const [key, value] of game.headers) headers[key] = value;

    const gameId = crypto.randomUUID();
    await store.addGame({ id: gameId, pgn, headers, importedAt: new Date().toISOString() });

    const startResult = startingPosition(game.headers);
    if (startResult.isErr) throw new Error('Invalid starting position in PGN');
    const pos: Position = startResult.unwrap();

    const mainline = [...game.moves.mainline()];
    const total = mainline.length;
    const flagged: FlaggedSpot[] = [];

    // Pass 1: cheap scan across every ply for a dropped advantage.
    for (let i = 0; i < mainline.length; i++) {
        const moveNumber = Math.floor(i / 2) + 1;
        const mover = pos.turn;
        const beforeFen = makeFen(pos.toSetup());

        onProgress?.({ phase: 'scan', current: i + 1, total, detail: `move ${moveNumber}` });

        const evalBefore = await evalOnly(engine, beforeFen, { depth: SCAN_DEPTH, multiPv: 1 });
        if (!evalBefore) continue; // no legal moves -- shouldn't happen mid-mainline

        const move = parseSan(pos, mainline[i].san);
        if (!move) break; // malformed PGN; stop rather than desync
        pos.play(move);
        if (pos.isEnd()) continue; // game ended on this move -- nothing to grade past it

        const afterFen = makeFen(pos.toSetup());
        const evalAfter = await evalOnly(engine, afterFen, { depth: SCAN_DEPTH, multiPv: 1 });
        if (!evalAfter) continue;

        if (evalDrop(mover, evalBefore, evalAfter) < BLUNDER_THRESHOLD_CP) continue;

        if (mover === options.studySide) {
            // Your own blunder: drill the position before it, so next time
            // you find the move you missed instead of repeating it.
            flagged.push({ fen: normalizeFen(beforeFen), moveNumber, evalBefore, evalAfter });
        } else if (options.includeOpponentBlunders) {
            // The opponent's blunder: drill the position after it (which is
            // exactly studySide to move, since there are only two colors)
            // so you learn to punish it. evalBefore/evalAfter here both
            // just record this position's own eval -- there's no "your
            // move" to compare against yet, that's what the review grades.
            flagged.push({ fen: normalizeFen(afterFen), moveNumber, evalBefore: evalAfter, evalAfter });
        }
    }

    // Pass 2: deepen each flagged spot into a full card.
    let cardsCreated = 0;
    let cardsSkipped = 0;
    for (let i = 0; i < flagged.length; i++) {
        const spot = flagged[i];
        onProgress?.({ phase: 'deepen', current: i + 1, total: flagged.length, detail: `blunder ${i + 1}/${flagged.length}` });

        const card = await buildCard(engine, spot.fen, options.studySide, gameId, spot.moveNumber, spot.evalBefore, spot.evalAfter);
        const cardResult = await store.addCard(card);
        if (cardResult === 'inserted') cardsCreated++;
        else cardsSkipped++;
    }

    return { gameId, plies: total, cardsCreated, cardsSkipped };
}
