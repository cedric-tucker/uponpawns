// Card selection, grading, and FSRS scheduling. Knows about chess (Color,
// Score) but nothing about the board or the engine's wire protocol.
import { fsrs, generatorParameters, createEmptyCard } from 'ts-fsrs';
import type { Card as FsrsState, Grade as FsrsGrade } from 'ts-fsrs';
import type { Color } from 'chessops/types';
import type { Score } from './engine';

// Rough mapping from eval drop to an FSRS grade (see spec's Engine policy /
// Grading table). Values line up 1:1 with ts-fsrs's Rating enum
// (Again=1, Hard=2, Good=3, Easy=4) so a Grade can be passed straight in.
export type Grade = 1 | 2 | 3 | 4;

export interface AlternativeLine {
    move: string; // UCI
    score: Score;
    pv: string[];
}

export interface GradeLogEntry {
    date: string; // ISO
    grade: Grade;
    dropCp: number;
}

export interface Card {
    id: string;
    fen: string; // normalised: board, side to move, castling, en passant only
    sideToMove: Color;
    sourceGame: string; // id of the SourceGame this was found in
    moveNumber: number;
    evalBefore: Score;
    evalAfter: Score;
    correctLine: string[]; // UCI moves, precomputed at import
    alternatives: AlternativeLine[]; // MultiPV results at the source position
    precomputed: Record<string, Score>; // normalised FEN -> eval
    fsrs: FsrsState;
    history: GradeLogEntry[];
}

export function newFsrsState(now: Date): FsrsState {
    return createEmptyCard(now);
}

// A mate score isn't on the centipawn scale at all, but for grading
// purposes it only needs to swamp every threshold in the table: a mate
// found or missed is always at least as severe as the worst cp-based grade.
const MATE_EQUIVALENT_CP = 100_000;

function approxCp(score: Score): number {
    if (score.type === 'cp') return score.value;
    return score.value > 0 ? MATE_EQUIVALENT_CP : -MATE_EQUIVALENT_CP;
}

// How much ground did `mover` lose, in their own perspective, between two
// White-positive scores taken before and after their move?
export function evalDrop(mover: Color, before: Score, after: Score): number {
    const sign = mover === 'white' ? 1 : -1;
    return approxCp(before) * sign - approxCp(after) * sign;
}

export function gradeForDrop(dropCp: number): Grade {
    if (dropCp < 30) return 4; // Easy
    if (dropCp < 100) return 3; // Good
    if (dropCp < 150) return 2; // Hard
    return 1; // Again
}

// A review plays out several plies of the correct line. Failure ends the
// card immediately (Anki-style) rather than retrying -- see the spec's open
// question on this. When every ply is played out without an Again, the
// card's overall grade is the worst individual grade along the way, so a
// single shaky-but-not-wrong move still shows up to FSRS.
export function combineGrades(grades: Grade[]): Grade {
    return Math.min(...grades) as Grade;
}

const scheduler = fsrs(generatorParameters());

export function scheduleNext(state: FsrsState, grade: Grade, now: Date): FsrsState {
    const record = scheduler.repeat(state, now);
    return record[grade as FsrsGrade].card;
}

export function isDue(card: Card, now: Date): boolean {
    return card.fsrs.due.getTime() <= now.getTime();
}

export function pickDueCard(cards: Card[], now: Date): Card | undefined {
    const due = cards.filter((c) => isDue(c, now));
    due.sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime());
    return due[0];
}
