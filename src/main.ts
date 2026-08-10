import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

import { Chessground } from '@lichess-org/chessground';
import { Chess } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { parseSquare } from 'chessops/util';

import './style.css'

const board = document.getElementById('board');
if (!board) throw new Error('Board not found');

const pos = Chess.default();

const ground = Chessground(board, {
  movable: {
    free: false,
    color: 'white',
    dests: chessgroundDests(pos)
  }
});

ground.set({
  movable: {
    events: {
      after : (orig, dest) => {
        pos.play({
          from: parseSquare(orig)!,
          to: parseSquare(dest)!,
        });

      ground.set({
        turnColor: pos.turn,
        movable: { 
          color: pos.turn,
          dests: chessgroundDests(pos),
      },
      });
      },
    },
  },
});
