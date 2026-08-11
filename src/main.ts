import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { parseSquare, parseUci } from 'chessops/util';

import './style.css'

import { startEngine } from './engine';
import { makeFen } from 'chessops/fen';
import { start } from '@lichess-org/chessground/drag';

import { createBoard } from './board';
import type { Key } from '@lichess-org/chessground/types';


const boardElement = document.getElementById('board');
if (!boardElement) throw new Error('Board not found');

const pos = Chess.default();
const engine = await startEngine();

const view = createBoard(boardElement, onMove);
refresh();

function refresh() {
  view.render({
    fen:makeFen(pos.toSetup()),
    turn: pos.turn,
    dests: chessgroundDests(pos)
  });
}

async function onMove(orig: Key, dest: Key) {
  pos.play({ from: parseSquare(orig)!, to: parseSquare(dest)!});
  refresh();
  if(pos.isEnd()) return;
  
  const move = parseUci(await engine.bestMove(makeFen(pos.toSetup())))
  if (!move) return;
  pos.play(move);
  refresh();
}