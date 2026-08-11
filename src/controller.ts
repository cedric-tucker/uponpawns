// Mediator: owns every piece (game, board, engine, store) and routes
// between the app's three screens. Leaves never import this; this imports
// all of them.
import { Chess } from 'chessops/chess';
import type { Position } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseSquare, parseUci } from 'chessops/util';
import type { Key } from '@lichess-org/chessground/types';

import { createBoard } from './board';
import type { BoardView } from './board';
import { createGame, normalizeFen } from './game';
import type { Game } from './game';
import { startEngine } from './engine';
import type { Score, SearchInfo } from './engine';
import { openStore } from './store';
import { buildCard, importPgn } from './import';
import type { ImportProgress } from './import';
import {
    combineGrades,
    evalDrop,
    gradeForDrop,
    pickDueCard,
    scheduleNext,
} from './review';
import type { Card, Grade } from './review';
import { currentTheme, toggleTheme } from './theme';
import type { Theme } from './theme';

const MIN_EVAL_DEPTH = 8;
const MATE_FRACTION = 0.97;
const REVIEW_TIME_MS = 1000; // "Review: ~1s, and ideally never hit at all."

const GRADE_LABELS: Record<Grade, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

type ScreenName = 'play' | 'import' | 'review';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing required element #${id}`);
    return found as T;
}

function sanForUci(pos: Position, uci: string): string | undefined {
    const move = parseUci(uci);
    return move ? makeSan(pos, move) : undefined;
}

export async function startApp(): Promise<void> {
    const dom = {
        navButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-btn')),
        dueCount: el('due-count'),
        themeToggle: el<HTMLButtonElement>('theme-toggle'),
        screens: {
            play: el('screen-play'),
            import: el('screen-import'),
            review: el('screen-review'),
        } satisfies Record<ScreenName, HTMLElement>,

        board: el('board'),
        reset: el<HTMLButtonElement>('reset'),
        status: el('status'),
        history: el('history'),

        pgnInput: el<HTMLTextAreaElement>('pgn-input'),
        importBtn: el<HTMLButtonElement>('import-btn'),
        importProgress: el('import-progress'),
        importResult: el('import-result'),
        manualFen: el<HTMLInputElement>('manual-fen'),
        manualAddBtn: el<HTMLButtonElement>('manual-add-btn'),
        manualResult: el('manual-result'),
        exportBtn: el<HTMLButtonElement>('export-btn'),
        importFile: el<HTMLInputElement>('import-file'),
        collectionResult: el('collection-result'),

        reviewBoard: el('review-board'),
        reviewInfo: el('review-info'),
        reviewFeedback: el('review-feedback'),
        showCorrectBtn: el<HTMLButtonElement>('show-correct-btn'),
        nextCardBtn: el<HTMLButtonElement>('next-card-btn'),
    };

    const engine = await startEngine();
    const store = await openStore();

    // ---- Theme toggle ----------------------------------------------------
    // Label reads as what clicking it *does*, not the mode it's currently
    // in -- "Dark" while light, "Light" while dark.
    function themeLabel(t: Theme): string {
        return t === 'dark' ? 'Light' : 'Dark';
    }
    dom.themeToggle.textContent = themeLabel(currentTheme());
    dom.themeToggle.addEventListener('click', () => {
        dom.themeToggle.textContent = themeLabel(toggleTheme());
    });

    // ---- Screen switching ----------------------------------------------
    function showScreen(name: ScreenName) {
        for (const [key, screen] of Object.entries(dom.screens)) {
            screen.classList.toggle('active', key === name);
        }
        for (const btn of dom.navButtons) {
            btn.classList.toggle('active', btn.dataset.screen === name);
        }
        if (name === 'review') void loadNextCard();
    }
    for (const btn of dom.navButtons) {
        btn.addEventListener('click', () => showScreen(btn.dataset.screen as ScreenName));
    }

    async function refreshDueCount() {
        const due = await store.getDueCards(new Date());
        dom.dueCount.textContent = due.length ? ` (${due.length})` : '';
    }
    void refreshDueCount();

    // ---- Play screen: free play against the engine ---------------------
    // (Same behaviour as stages 1-2; just relocated into the controller.)
    let playGame: Game = createGame();
    let interactive = true;
    let latestEvalFraction: number | null = null;
    let evalFrameScheduled = false;

    const playBoard: BoardView = createBoard(dom.board, onPlayMove);

    dom.reset.addEventListener('click', resetPlay);
    refreshPlay();

    function resetPlay() {
        engine.stop();
        playGame = createGame();
        interactive = true;
        latestEvalFraction = null;
        refreshPlay();
        playBoard.renderEval(null);
    }

    function refreshPlay() {
        playBoard.render({
            fen: playGame.fen(),
            turn: playGame.turn(),
            dests: chessgroundDests(playGame.position()),
            interactive,
        });
        dom.history.textContent = playGame.history().join(' ');
        const outcome = playGame.outcome();
        dom.status.textContent = !outcome ? '' : !outcome.winner ? 'Draw' : `${outcome.winner === 'white' ? 'White' : 'Black'} wins`;
    }

    function scoreToFraction(score: Score): number {
        if (score.type === 'mate') return score.value > 0 ? MATE_FRACTION : 1 - MATE_FRACTION;
        return 1 / (1 + Math.exp(-score.value / 350));
    }

    function onSearchInfo(info: SearchInfo) {
        if (info.depth < MIN_EVAL_DEPTH) return;
        latestEvalFraction = scoreToFraction(info.score);
        if (evalFrameScheduled) return;
        evalFrameScheduled = true;
        requestAnimationFrame(() => {
            evalFrameScheduled = false;
            if (interactive) playBoard.renderEval(latestEvalFraction);
        });
    }

    async function onPlayMove(orig: Key, dest: Key) {
        const from = parseSquare(orig)!;
        const to = parseSquare(dest)!;
        playGame.playSquares(from, to);
        refreshPlay();
        if (playGame.isEnd()) return;

        interactive = false;
        refreshPlay();
        playBoard.renderEval(null);
        try {
            const uci = await engine.bestMove(playGame.fen(), onSearchInfo);
            playGame.playUci(uci);
        } catch {
            // Search was stopped (e.g. reset mid-think). Nothing to play.
        } finally {
            interactive = true;
            refreshPlay();
            playBoard.renderEval(latestEvalFraction);
        }
    }

    // ---- Import screen: PGN blunder detection, manual entry, and the
    // collection's export/import (spec steps 3, 6, 8) -----------------
    dom.importBtn.addEventListener('click', async () => {
        const pgn = dom.pgnInput.value.trim();
        if (!pgn) return;
        dom.importBtn.disabled = true;
        dom.importResult.textContent = '';
        try {
            const result = await importPgn(pgn, engine, store, (p: ImportProgress) => {
                dom.importProgress.textContent = `${p.phase === 'scan' ? 'Scanning' : 'Analysing'} ${p.current}/${p.total} (${p.detail})`;
            });
            dom.importResult.textContent =
                `Walked ${result.plies} plies -> ${result.cardsCreated} cards created` +
                (result.cardsSkipped ? `, ${result.cardsSkipped} duplicate(s) skipped` : '') +
                '.';
            void refreshDueCount();
        } catch (err) {
            dom.importResult.textContent = `Import failed: ${(err as Error).message}`;
        } finally {
            dom.importProgress.textContent = '';
            dom.importBtn.disabled = false;
        }
    });

    dom.manualAddBtn.addEventListener('click', async () => {
        const rawFen = dom.manualFen.value.trim();
        if (!rawFen) return;
        dom.manualAddBtn.disabled = true;
        dom.manualResult.textContent = 'Analysing...';
        try {
            const pos = Chess.fromSetup(parseFen(rawFen).unwrap()).unwrap();
            const fen = normalizeFen(makeFen(pos.toSetup()));
            await store.addGame({ id: 'manual', pgn: '', headers: { Source: 'manual entry' }, importedAt: new Date().toISOString() });
            const card = await buildCard(engine, fen, pos.turn, 'manual', 0);
            const result = await store.addCard(card);
            dom.manualResult.textContent = result === 'inserted' ? 'Card added.' : 'That position is already in your collection.';
            if (result === 'inserted') dom.manualFen.value = '';
            void refreshDueCount();
        } catch (err) {
            dom.manualResult.textContent = `Couldn't add that: ${(err as Error).message}`;
        } finally {
            dom.manualAddBtn.disabled = false;
        }
    });

    dom.exportBtn.addEventListener('click', async () => {
        const json = await store.exportAll();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `uponpawns-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    dom.importFile.addEventListener('change', async () => {
        const file = dom.importFile.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const result = await store.importAll(text);
            dom.collectionResult.textContent = `Imported ${result.cardsAdded} card(s), skipped ${result.cardsSkipped} duplicate(s).`;
            void refreshDueCount();
        } catch (err) {
            dom.collectionResult.textContent = `Import failed: ${(err as Error).message}`;
        } finally {
            dom.importFile.value = '';
        }
    });

    // ---- Review screen ---------------------------------------------------
    let reviewGame: Game | null = null;
    let currentCard: Card | null = null;
    let stepIndex = 0;
    let attemptSteps: { grade: Grade; dropCp: number }[] = [];
    let pendingCorrectSan: string | undefined;
    // Set once an attempt ends (fail or complete) so a stray drag before
    // "Next card" is clicked can't replay into an already-graded card and
    // double-schedule its FSRS state. Same pattern as Play mode's
    // `interactive` flag -- one render path, no second source of truth.
    let reviewLocked = false;

    const reviewBoard: BoardView = createBoard(dom.reviewBoard, onReviewMove);

    dom.nextCardBtn.addEventListener('click', () => void loadNextCard());
    dom.showCorrectBtn.addEventListener('click', () => {
        dom.reviewFeedback.textContent += pendingCorrectSan ? ` Correct move: ${pendingCorrectSan}.` : ' (no line recorded)';
        dom.showCorrectBtn.hidden = true;
    });

    async function loadNextCard() {
        const due = await store.getDueCards(new Date());
        const card = pickDueCard(due, new Date()) ?? null;
        currentCard = card;
        stepIndex = 0;
        attemptSteps = [];
        pendingCorrectSan = undefined;
        reviewLocked = false;
        dom.showCorrectBtn.hidden = true;
        dom.nextCardBtn.hidden = true;
        dom.reviewFeedback.textContent = '';

        if (!card) {
            reviewGame = null;
            dom.reviewInfo.textContent = due.length === 0 ? 'No cards due. Nothing to review right now.' : '';
            reviewBoard.render({ fen: makeFen(Chess.default().toSetup()), turn: 'white', dests: new Map(), interactive: false });
            return;
        }
        reviewGame = createGame(card.fen);
        dom.reviewInfo.textContent =
            `Move ${card.moveNumber || '?'} · ${card.sideToMove} to move · play the continuation`;
        refreshReviewBoard();
    }

    function refreshReviewBoard() {
        if (!reviewGame) return;
        reviewBoard.render({
            fen: reviewGame.fen(),
            turn: reviewGame.turn(),
            dests: chessgroundDests(reviewGame.position()),
            // No free engine opponent here -- the reviewer plays every ply --
            // but once the attempt has ended, further drags must be refused
            // until "Next card", not silently re-graded into the same card.
            interactive: !reviewLocked,
        });
    }

    // Cache-first, per the spec: the correct path should already be
    // precomputed from import; a live ~1s call only happens off the line.
    async function scoreAt(card: Card, fen: string): Promise<Score> {
        const key = normalizeFen(fen);
        const cached = card.precomputed[key];
        if (cached) return cached;
        const result = await engine.analyze(fen, { movetime: REVIEW_TIME_MS, multiPv: 1 });
        const score = result.lines[0]?.score;
        if (score) {
            card.precomputed[key] = score;
            void store.updateCard(card); // grow the cache for next time
        }
        return score ?? { type: 'cp', value: 0 };
    }

    async function onReviewMove(orig: Key, dest: Key) {
        const card = currentCard;
        if (!card || !reviewGame || reviewLocked) return;

        const mover = reviewGame.turn();
        const beforeFen = reviewGame.fen();
        const correctUci = card.correctLine[stepIndex];
        const correctSan = correctUci ? sanForUci(reviewGame.position(), correctUci) : undefined;

        const from = parseSquare(orig)!;
        const to = parseSquare(dest)!;
        const san = reviewGame.playSquares(from, to);
        if (!san) {
            refreshReviewBoard();
            return;
        }

        // Lock immediately -- grading below awaits the engine, and nothing
        // should be draggable while that's in flight, same reasoning as
        // Play mode's `interactive` flag during the engine's own search.
        reviewLocked = true;
        refreshReviewBoard();

        const beforeScore = await scoreAt(card, beforeFen);
        let afterScore: Score;
        if (reviewGame.isEnd()) {
            const outcome = reviewGame.outcome();
            afterScore = outcome?.winner === mover
                ? { type: 'mate', value: mover === 'white' ? 1 : -1 }
                : { type: 'cp', value: 0 }; // stalemate/insufficient material -- call it roughly even
        } else {
            afterScore = await scoreAt(card, reviewGame.fen());
        }

        const drop = Math.round(evalDrop(mover, beforeScore, afterScore));
        const grade = gradeForDrop(drop);
        attemptSteps.push({ grade, dropCp: drop });
        dom.reviewFeedback.textContent = `${san}: ${GRADE_LABELS[grade]} (${drop >= 0 ? '-' : '+'}${Math.abs(drop)}cp)`;

        if (grade === 1) {
            pendingCorrectSan = correctSan;
            await finishAttempt();
            return;
        }

        stepIndex++;
        if (stepIndex >= card.correctLine.length || reviewGame.isEnd()) {
            await finishAttempt();
            return;
        }

        // Attempt continues -- unlock for the next ply.
        reviewLocked = false;
        refreshReviewBoard();
    }

    async function finishAttempt() {
        const card = currentCard;
        if (!card || attemptSteps.length === 0) return;
        const grade = combineGrades(attemptSteps.map((s) => s.grade));
        const worstDrop = Math.max(...attemptSteps.map((s) => s.dropCp));
        const now = new Date();
        card.fsrs = scheduleNext(card.fsrs, grade, now);
        card.history.push({ date: now.toISOString(), grade, dropCp: worstDrop });
        await store.updateCard(card);
        dom.reviewFeedback.textContent += ` — card grade: ${GRADE_LABELS[grade]}. Next due ${card.fsrs.due.toLocaleDateString()}.`;
        dom.showCorrectBtn.hidden = !pendingCorrectSan;
        dom.nextCardBtn.hidden = false;
        void refreshDueCount();
    }

    showScreen('play');
}
