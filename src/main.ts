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
import { createBoard } from './board';

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

const engine = await startEngine();
const view = createBoard(boardElement, onMove);

resetButton.addEventListener('click', reset);

refresh();

function reset() {
  engine.stop();
  pos = Chess.default();
  history = [];
  interactive = true;
  refresh();
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
  try {
    const uci = await engine.bestMove(makeFen(pos.toSetup()));
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
  }
}
