import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

import { Chess } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen } from 'chessops/fen';
import { makeSanAndPlay } from 'chessops/san';
import { parseSquare, parseUci } from 'chessops/util';
import type { NormalMove } from 'chessops/types';
import type { Key } from '@lichess-org/chessground/types';

import './style.css'

import { startEngine } from './engine';
import type { Score, SearchInfo } from './engine';
import { createBoard } from './board';

// Evals below this depth swing wildly and just produce jitter.
const MIN_EVAL_DEPTH = 8;
// Mate scores clamp to the extremes rather than trying to place them on the
// same scale as a centipawn count.
const MATE_FRACTION = 0.97;

const boardElement = document.getElementById('board');
const resetButton = document.getElementById('reset');
const statusElement = document.getElementById('status');
const historyElement = document.getElementById('history');
if (!boardElement || !resetButton || !statusElement || !historyElement) {
  throw new Error('Required DOM elements not found');
}

let pos = Chess.default();
let history: string[] = [];
let interactive = true;
let latestEvalFraction: number | null = null;
let evalFrameScheduled = false;

const engine = await startEngine();
const view = createBoard(boardElement, onMove);

resetButton.addEventListener('click', reset);

refresh();

function reset() {
  engine.stop();
  pos = Chess.default();
  history = [];
  interactive = true;
  latestEvalFraction = null;
  refresh();
  view.renderEval(null);
}

function refresh() {
  view.render({
    fen: makeFen(pos.toSetup()),
    turn: pos.turn,
    dests: chessgroundDests(pos),
    interactive,
  });
  renderHistory();
  renderStatus();
}

function renderHistory() {
  historyElement!.textContent = history.join(' ');
}

function renderStatus() {
  const outcome = pos.outcome();
  if (!outcome) {
    statusElement!.textContent = '';
  } else if (!outcome.winner) {
    statusElement!.textContent = 'Draw';
  } else {
    statusElement!.textContent = `${outcome.winner === 'white' ? 'White' : 'Black'} wins`;
  }
}

// Maps a White-positive score onto White's share of the eval bar in [0, 1].
// A logistic curve rather than a linear one: the difference between +8 and
// +12 is meaningless while +0.2 vs +0.8 matters a great deal near equality.
function scoreToFraction(score: Score): number {
  if (score.type === 'mate') {
    return score.value > 0 ? MATE_FRACTION : 1 - MATE_FRACTION;
  }
  return 1 / (1 + Math.exp(-score.value / 350));
}

// Showing live eval during the engine's own search is a spoiler -- it tells
// you what the engine is about to play before it plays it. So this only
// ever reaches the screen once `interactive` is back on, i.e. once it's the
// human's turn to think about the position the engine just moved into.
function onSearchInfo(info: SearchInfo) {
  if (info.depth < MIN_EVAL_DEPTH) return;
  latestEvalFraction = scoreToFraction(info.score);
  if (evalFrameScheduled) return;
  evalFrameScheduled = true;
  requestAnimationFrame(() => {
    evalFrameScheduled = false;
    if (interactive) view.renderEval(latestEvalFraction);
  });
}

// Pawn reaching the back rank needs a promotion role or `pos.play` leaves an
// illegal pawn sitting on rank 1/8. Auto-queen for now; a picker can replace
// this later.
function isPromotion(from: number, to: number): boolean {
  const piece = pos.board.get(from);
  if (!piece || piece.role !== 'pawn') return false;
  const rank = to >> 3;
  return rank === 0 || rank === 7;
}

async function onMove(orig: Key, dest: Key) {
  const from = parseSquare(orig)!;
  const to = parseSquare(dest)!;
  const move: NormalMove = { from, to, promotion: isPromotion(from, to) ? 'queen' : undefined };
  history.push(makeSanAndPlay(pos, move));
  refresh();
  if (pos.isEnd()) return;

  interactive = false;
  refresh();
  view.renderEval(null); // hide -- the engine is now thinking about its own move
  try {
    const uci = await engine.bestMove(makeFen(pos.toSetup()), onSearchInfo);
    const engineMove = parseUci(uci);
    if (!engineMove) return;
    history.push(makeSanAndPlay(pos, engineMove));
  } catch {
    // Search was stopped (e.g. the user hit reset mid-think). Nothing to play.
  } finally {
    // Re-derive from the current `pos` rather than assuming it's still the
    // position this call started with -- a reset may have replaced it while
    // this was in flight, and refresh() picks that up for free.
    interactive = true;
    refresh();
    view.renderEval(latestEvalFraction);
  }
}
