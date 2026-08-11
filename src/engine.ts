const ENGINE_TIME_LIMIT_MS = 5000;

// Mate scores are a different unit from centipawns (moves-to-mate, not an
// evaluation), so they get their own branch rather than being folded into
// the same number.
export type Score =
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };

export interface SearchInfo {
    depth: number;
    score: Score;
}

export interface Engine {
    bestMove(fen: string, onInfo?: (info: SearchInfo) => void): Promise<string>;
    stop(): void;
    quit(): void;
}

interface PendingSearch {
    resolve: (move: string) => void;
    reject: (err: Error) => void;
    onMessage: (e: MessageEvent) => void;
}

// Stockfish reports scores from the side-to-move's point of view. Normalise
// to White-positive here, at the boundary where the engine's answer enters
// the app, so nothing downstream has to think about whose turn it was.
function parseInfo(line: string, sideToMove: 'white' | 'black'): SearchInfo | undefined {
    if (!line.startsWith('info ')) return undefined;
    const depthMatch = line.match(/ depth (\d+)/);
    const scoreMatch = line.match(/ score (cp|mate) (-?\d+)/);
    if (!depthMatch || !scoreMatch) return undefined;

    const sign = sideToMove === 'white' ? 1 : -1;
    const type = scoreMatch[1] as 'cp' | 'mate';
    const value = Number(scoreMatch[2]) * sign;
    return { depth: Number(depthMatch[1]), score: { type, value } };
}

export function startEngine(): Promise<Engine> {
    return new Promise((resolve) => {
        const worker = new Worker('/engine/stockfish-18-single.js');

        // At most one search in flight at a time. Sending `position`/`go` while
        // the engine is already searching can hang the wasm build outright.
        let pending: PendingSearch | null = null;

        const bestMove = (fen: string, onInfo?: (info: SearchInfo) => void): Promise<string> => {
            if (pending) {
                return Promise.reject(new Error('Engine is already searching a position'));
            }
            const sideToMove = fen.split(' ')[1] === 'b' ? 'black' : 'white';
            return new Promise((resolveMove, rejectMove) => {
                const onMessage = (e: MessageEvent) => {
                    const line = e.data as string;
                    if (line.startsWith('bestmove')) {
                        worker.removeEventListener('message', onMessage);
                        pending = null;
                        resolveMove(line.split(' ')[1]);
                    } else if (onInfo) {
                        const info = parseInfo(line, sideToMove);
                        if (info) onInfo(info);
                    }
                };
                pending = { resolve: resolveMove, reject: rejectMove, onMessage };
                worker.addEventListener('message', onMessage);
                worker.postMessage(`position fen ${fen}`);
                worker.postMessage(`go movetime ${ENGINE_TIME_LIMIT_MS}`);
            });
        };

        const stop = () => {
            if (!pending) return;
            worker.removeEventListener('message', pending.onMessage);
            pending.reject(new Error('Search stopped'));
            pending = null;
            worker.postMessage('stop');
        };

        const quit = () => worker.terminate();

        const onReady = (e: MessageEvent) => {
            if (e.data === 'readyok') {
                worker.removeEventListener('message', onReady);
                resolve({ bestMove, stop, quit });
            }
        };

        worker.addEventListener('message', onReady);
        worker.postMessage('uci');
        worker.postMessage('isready');
    })
}
