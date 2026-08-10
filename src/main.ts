import './style.css'
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

import { Chessground } from '@lichess-org/chessground';

const board = document.getElementById('board');
if (!board) throw new Error('Board not found');
const ground = Chessground(board, {});
