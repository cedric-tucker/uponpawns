// Mediator: owns every piece (game, board, engine, store) and routes
// between the app's three screens. Leaves never import this; this imports
// all of them.
import { Chess } from 'chessops/chess';
import type { Position } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseSquare, parseUci } from 'chessops/util';
import type { Color } from 'chessops/types';
import type { Key } from '@lichess-org/chessground/types';

import { createBoard } from './board';
import type { BoardView } from './board';
import { createGame, normalizeFen, turnFromFen } from './game';
import type { Game } from './game';
import { startEngine } from './engine';
import type { Score, SearchInfo } from './engine';
import { openStore } from './store';
import { buildCard, importPgn } from './import';
import type { ImportOptions, ImportProgress } from './import';
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
import { initBoardSize, makeResizable } from './resize';
import { createMoveList } from './movelist';
import type { MoveListView, MoveTone } from './movelist';
import { glitchText } from './glitchtext';
import { mountPawnParticles } from './pawnparticles';

const MIN_EVAL_DEPTH = 8;
const MATE_FRACTION = 0.97;
const REVIEW_TIME_MS = 1000; // "Review: ~1s, and ideally never hit at all."
// Home's dot field is a fixed dark "tech" room independent of light/dark --
// same reasoning as the board's own frozen colors.
const HOME_DOT_COLOR = '#59b3a7';
const HOME_HEADLINE_FONT = '-apple-system, "Segoe UI", system-ui, sans-serif';

// FSRS's own vocabulary (Again/Hard/Good/Easy) describes recall difficulty,
// not move quality -- "Good" in particular reads as reassuring when a
// 30-100cp drop is still a real mistake. These read the way a chess move
// actually should: only the best-available move reads as good.
const GRADE_LABELS: Record<Grade, string> = { 1: 'Blunder', 2: 'Mistake', 3: 'Inaccuracy', 4: 'Best' };
const GRADE_TONES: Record<Grade, MoveTone> = { 1: 'bad', 2: 'bad', 3: 'warn', 4: 'good' };

type ScreenName = 'home' | 'play' | 'import' | 'review';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing required element #${id}`);
    return found as T;
}

function sanForUci(pos: Position, uci: string): string | undefined {
    const move = parseUci(uci);
    return move ? makeSan(pos, move) : undefined;
}

function statusText(outcome: { winner: Color | undefined } | undefined): string {
    if (!outcome) return '';
    if (!outcome.winner) return 'Draw';
    return `${outcome.winner === 'white' ? 'White' : 'Black'} wins`;
}

export async function startApp(): Promise<void> {
    initBoardSize();

    const dom = {
        navButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-btn')),
        dueCount: el('due-count'),
        themeToggle: el<HTMLButtonElement>('theme-toggle'),
        screens: {
            home: el('screen-home'),
            play: el('screen-play'),
            import: el('screen-import'),
            review: el('screen-review'),
        } satisfies Record<ScreenName, HTMLElement>,

        homeHeadline: el('home-headline'),
        homeCanvas: el<HTMLCanvasElement>('home-particles'),

        boardWrap: el('board-wrap'),
        boardResize: el('board-resize'),
        board: el('board'),
        playWhiteBtn: el<HTMLButtonElement>('play-white-btn'),
        playBlackBtn: el<HTMLButtonElement>('play-black-btn'),
        reset: el<HTMLButtonElement>('reset'),
        status: el('status'),
        history: el('history'),

        studySide: el<HTMLSelectElement>('study-side'),
        includeOpponentBlunders: el<HTMLInputElement>('include-opponent-blunders'),
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
        cardListCount: el('card-list-count'),
        cardList: el('card-list'),

        reviewBoardWrap: el('review-board-wrap'),
        reviewResize: el('review-resize'),
        reviewBoard: el('review-board'),
        reviewInfo: el('review-info'),
        reviewFeedback: el('review-feedback'),
        reviewHistory: el('review-history'),
        showCorrectBtn: el<HTMLButtonElement>('show-correct-btn'),
        nextCardBtn: el<HTMLButtonElement>('next-card-btn'),
        removeCardBtn: el<HTMLButtonElement>('remove-card-btn'),
    };

    const engine = await startEngine();
    const store = await openStore();

    makeResizable(dom.boardWrap, dom.boardResize);
    makeResizable(dom.reviewBoardWrap, dom.reviewResize);

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
    function activeScreen(): ScreenName | null {
        for (const [key, screen] of Object.entries(dom.screens)) {
            if (screen.classList.contains('active')) return key as ScreenName;
        }
        return null;
    }
    function showScreen(name: ScreenName) {
        for (const [key, screen] of Object.entries(dom.screens)) {
            screen.classList.toggle('active', key === name);
        }
        for (const btn of dom.navButtons) {
            btn.classList.toggle('active', btn.dataset.screen === name);
        }
        // The particle field's animation loop is pure waste behind a hidden
        // screen -- only run it while Home is actually showing.
        if (name === 'home') particleField.resume();
        else particleField.pause();
        if (name === 'review') void loadNextCard();
    }
    for (const btn of dom.navButtons) {
        btn.addEventListener('click', () => showScreen(btn.dataset.screen as ScreenName));
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.home-choice')) {
        btn.addEventListener('click', () => showScreen(btn.dataset.screen as ScreenName));
    }

    // ---- Home screen: nav-tab-free launch point, plus the flourish that
    // doesn't belong on the working screens (particle field, glitch text).
    const particleField = mountPawnParticles(dom.homeCanvas, HOME_DOT_COLOR);
    glitchText(dom.homeHeadline, HOME_HEADLINE_FONT);

    // Up/Down jump to the start/end of the game; Left/Right step one ply.
    // Ignored while typing in a text field, and scoped to whichever screen
    // is actually showing a board.
    document.addEventListener('keydown', (e) => {
        if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const screen = activeScreen();
        if (screen === 'play') {
            e.preventDefault();
            viewPly = stepPly(e.key, viewPly, playGame.plyCount());
            refreshPlay();
        } else if (screen === 'review' && reviewGame) {
            e.preventDefault();
            reviewViewPly = stepPly(e.key, reviewViewPly, reviewGame.plyCount());
            refreshReviewBoard();
        }
    });
    function stepPly(key: string, current: number, max: number): number {
        if (key === 'ArrowUp') return 0;
        if (key === 'ArrowDown') return max;
        if (key === 'ArrowLeft') return Math.max(0, current - 1);
        return Math.min(max, current + 1); // ArrowRight
    }

    async function refreshDueCount() {
        const due = await store.getDueCards(new Date());
        dom.dueCount.textContent = due.length ? ` (${due.length})` : '';
    }
    void refreshDueCount();

    // A way to take a card out of circulation without waiting for it to
    // come due -- browse the whole collection and remove anything you no
    // longer want drilled.
    async function refreshCardList() {
        const cards = await store.getAllCards();
        cards.sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime());
        dom.cardListCount.textContent = cards.length ? `${cards.length} card(s) in your collection` : 'No cards yet.';
        dom.cardList.innerHTML = '';
        for (const card of cards) {
            const row = document.createElement('div');
            row.className = 'card-row';

            const info = document.createElement('span');
            info.textContent = card.moveNumber
                ? `${card.sideToMove} to move · move ${card.moveNumber} · due ${card.fsrs.due.toLocaleDateString()}`
                : `${card.sideToMove} to move · manual · due ${card.fsrs.due.toLocaleDateString()}`;
            row.appendChild(info);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => void removeCard(card.id));
            row.appendChild(removeBtn);

            dom.cardList.appendChild(row);
        }
    }
    void refreshCardList();

    async function removeCard(id: string): Promise<void> {
        if (!confirm('Remove this card from your collection? This can\'t be undone.')) return;
        await store.deleteCard(id);
        void refreshDueCount();
        void refreshCardList();
    }

    // ---- Play screen: free play against the engine ---------------------
    let playGame: Game = createGame();
    let humanColor: Color = 'white';
    let interactive = true; // false while the engine is actually thinking
    let viewPly = 0; // which ply is displayed; may lag the live position
    let latestEvalFraction: number | null = null;
    let evalFrameScheduled = false;

    const playBoard: BoardView = createBoard(dom.board, onPlayMove);
    const playMoveList: MoveListView = createMoveList(dom.history, (ply) => {
        viewPly = ply;
        refreshPlay();
    });

    dom.reset.addEventListener('click', () => resetPlay());
    dom.playWhiteBtn.addEventListener('click', () => resetPlay('white'));
    dom.playBlackBtn.addEventListener('click', () => resetPlay('black'));
    refreshPlay();

    function resetPlay(color?: Color) {
        engine.stop();
        if (color) humanColor = color;
        dom.playWhiteBtn.classList.toggle('active', humanColor === 'white');
        dom.playBlackBtn.classList.toggle('active', humanColor === 'black');
        playGame = createGame();
        viewPly = 0;
        interactive = true;
        latestEvalFraction = null;
        refreshPlay();
        playBoard.renderEval(null);
        if (playGame.turn() !== humanColor) void triggerEngineMove();
    }

    function refreshPlay() {
        const fen = playGame.fenAt(viewPly);
        const live = viewPly === playGame.plyCount();
        const canDrag = live && interactive && turnFromFen(fen) === humanColor;
        playBoard.render({
            fen,
            turn: turnFromFen(fen),
            dests: canDrag ? chessgroundDests(playGame.position()) : new Map(),
            interactive: canDrag,
            orientation: humanColor,
        });
        playMoveList.render(playGame.history(), viewPly === 0 ? null : viewPly);
        dom.status.textContent = statusText(playGame.outcome());
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

    async function triggerEngineMove() {
        interactive = false;
        refreshPlay();
        playBoard.renderEval(null);
        try {
            const uci = await engine.bestMove(playGame.fen(), onSearchInfo);
            playGame.playUci(uci);
            viewPly = playGame.plyCount();
        } catch {
            // Search was stopped (e.g. reset mid-think). Nothing to play.
        } finally {
            interactive = true;
            refreshPlay();
            playBoard.renderEval(latestEvalFraction);
        }
    }

    async function onPlayMove(orig: Key, dest: Key) {
        const from = parseSquare(orig)!;
        const to = parseSquare(dest)!;
        playGame.playSquares(from, to);
        viewPly = playGame.plyCount();
        refreshPlay();
        if (playGame.isEnd()) return;
        await triggerEngineMove();
    }

    // ---- Import screen: PGN blunder detection, manual entry, and the
    // collection's export/import (spec steps 3, 6, 8) -----------------
    dom.importBtn.addEventListener('click', async () => {
        const pgn = dom.pgnInput.value.trim();
        if (!pgn) return;
        const options: ImportOptions = {
            studySide: dom.studySide.value === 'black' ? 'black' : 'white',
            includeOpponentBlunders: dom.includeOpponentBlunders.checked,
        };
        dom.importBtn.disabled = true;
        dom.importResult.textContent = '';
        try {
            const result = await importPgn(pgn, engine, store, options, (p: ImportProgress) => {
                dom.importProgress.textContent = `${p.phase === 'scan' ? 'Scanning' : 'Analysing'} ${p.current}/${p.total} (${p.detail})`;
            });
            dom.importResult.textContent =
                `Walked ${result.plies} plies -> ${result.cardsCreated} cards created` +
                (result.cardsSkipped ? `, ${result.cardsSkipped} duplicate(s) skipped` : '') +
                '.';
            void refreshDueCount();
            void refreshCardList();
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
            void refreshCardList();
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
            void refreshCardList();
        } catch (err) {
            dom.collectionResult.textContent = `Import failed: ${(err as Error).message}`;
        } finally {
            dom.importFile.value = '';
        }
    });

    // ---- Review screen ---------------------------------------------------
    let reviewGame: Game | null = null;
    let currentCard: Card | null = null;
    let reviewViewPly = 0;
    let stepIndex = 0;
    let attemptSteps: { grade: Grade; dropCp: number }[] = [];
    let pendingCorrectSan: string | undefined;
    let pendingCorrectUci: string | undefined;
    // Set once an attempt ends (fail or complete) so a stray drag before
    // "Next card" is clicked can't replay into an already-graded card and
    // double-schedule its FSRS state. Same pattern as Play mode's
    // `interactive` flag -- one render path, no second source of truth.
    let reviewLocked = false;

    const reviewBoard: BoardView = createBoard(dom.reviewBoard, onReviewMove);
    const reviewMoveList: MoveListView = createMoveList(dom.reviewHistory, (ply) => {
        reviewViewPly = ply;
        refreshReviewBoard();
    });

    dom.nextCardBtn.addEventListener('click', () => void loadNextCard());
    dom.removeCardBtn.addEventListener('click', async () => {
        const card = currentCard;
        // Disabled while reviewLocked (see refreshReviewBoard) so this can't
        // race a grading call still in flight -- scoreAt()'s cache-growing
        // store.updateCard() would otherwise silently resurrect a card
        // deleted out from under it.
        if (!card || reviewLocked) return;
        if (!confirm('Remove this card from your collection? This can\'t be undone.')) return;
        await store.deleteCard(card.id);
        void refreshCardList();
        await loadNextCard();
    });
    dom.showCorrectBtn.addEventListener('click', () => {
        if (pendingCorrectUci) {
            reviewBoard.showHint(pendingCorrectUci.slice(0, 2) as Key, pendingCorrectUci.slice(2, 4) as Key);
        }
        dom.reviewFeedback.textContent += pendingCorrectSan ? ` Correct move: ${pendingCorrectSan}.` : '';
        dom.showCorrectBtn.hidden = true;
    });

    async function loadNextCard() {
        const due = await store.getDueCards(new Date());
        const card = pickDueCard(due, new Date()) ?? null;
        currentCard = card;
        reviewViewPly = 0;
        stepIndex = 0;
        attemptSteps = [];
        pendingCorrectSan = undefined;
        pendingCorrectUci = undefined;
        reviewLocked = false;
        dom.showCorrectBtn.hidden = true;
        dom.nextCardBtn.hidden = true;
        dom.reviewFeedback.textContent = '';

        if (!card) {
            reviewGame = null;
            dom.reviewInfo.textContent = due.length === 0 ? 'No cards due. Nothing to review right now.' : '';
            reviewBoard.render({ fen: makeFen(Chess.default().toSetup()), turn: 'white', dests: new Map(), interactive: false, orientation: 'white' });
            dom.reviewHistory.innerHTML = '';
            dom.removeCardBtn.disabled = true;
            return;
        }
        reviewGame = createGame(card.fen);
        dom.reviewInfo.textContent =
            `Move ${card.moveNumber || '?'} · ${card.sideToMove} to move · play the continuation`;
        refreshReviewBoard();
    }

    function refreshReviewBoard() {
        if (!reviewGame || !currentCard) return;
        const live = reviewViewPly === reviewGame.plyCount();
        reviewBoard.render({
            fen: reviewGame.fenAt(reviewViewPly),
            turn: turnFromFen(reviewGame.fenAt(reviewViewPly)),
            dests: (live && !reviewLocked) ? chessgroundDests(reviewGame.position()) : new Map(),
            // No free engine opponent here -- the reviewer plays every ply --
            // but once the attempt has ended, further drags must be refused
            // until "Next card", not silently re-graded into the same card.
            interactive: live && !reviewLocked,
            orientation: currentCard.sideToMove,
        });
        dom.removeCardBtn.disabled = reviewLocked;
        reviewMoveList.render(
            reviewGame.history(),
            reviewViewPly === 0 ? null : reviewViewPly,
            attemptSteps.map((s) => GRADE_TONES[s.grade]),
        );
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
        reviewViewPly = reviewGame.plyCount();

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
        refreshReviewBoard();

        if (grade === 1) {
            pendingCorrectSan = correctSan;
            pendingCorrectUci = correctUci;
            await finishAttempt();
            return;
        }

        stepIndex++;
        await continueAfterPly();
    }

    // You only ever play one side. If the line has more to go and it's now
    // the *other* side's turn, that move is auto-played from the card's own
    // correctLine rather than waited on -- there's no free engine opponent,
    // but there's also no reason to make the reviewer stand in for one.
    async function continueAfterPly() {
        const card = currentCard;
        if (!card || !reviewGame) return;

        if (stepIndex >= card.correctLine.length || reviewGame.isEnd()) {
            await finishAttempt();
            return;
        }

        if (reviewGame.turn() !== card.sideToMove) {
            await new Promise((r) => setTimeout(r, 350)); // let the reveal register as a move, not a jump cut
            const uci = card.correctLine[stepIndex];
            if (uci) {
                reviewGame.playUci(uci);
                reviewViewPly = reviewGame.plyCount();
                stepIndex++;
            }
            refreshReviewBoard();
            if (stepIndex >= card.correctLine.length || reviewGame.isEnd()) {
                await finishAttempt();
                return;
            }
        }

        // Attempt continues -- unlock for the reviewer's next ply.
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

    showScreen('home');
}
