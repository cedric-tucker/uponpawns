import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
// No chessground.brown.css: the board's own square colors live in
// style.css as theme tokens, so they switch with light/dark.
import './style.css';

import { startApp } from './controller';

startApp();
