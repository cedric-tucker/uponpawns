const ENGINE_TIME_LIMIT_MS = 5000;

export interface Engine {
    bestMove(fen: string): Promise<string>;
    stop(): void;
    quit(): void;
}

interface PendingSearch {
    resolve: (move: string) => void;
    reject: (err: Error) => void;
    onMessage: (e: MessageEvent) => void;
}

export function startEngine(): Promise<Engine> {
    return new Promise((resolve) => {
        const worker = new Worker('/engine/stockfish-18-single.js');

        // At most one search in flight at a time. Sending `position`/`go` while
        // the engine is already searching can hang the wasm build outright.
        let pending: PendingSearch | null = null;

        const bestMove = (fen: string): Promise<string> => {
            if (pending) {
                return Promise.reject(new Error('Engine is already searching a position'));
            }
            return new Promise((resolveMove, rejectMove) => {
                const onMessage = (e: MessageEvent) => {
                    const line = e.data as string;
                    if (line.startsWith('bestmove')) {
                        worker.removeEventListener('message', onMessage);
                        pending = null;
                        resolveMove(line.split(' ')[1]);
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
