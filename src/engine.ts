const PLAY_TIME_LIMIT_MS = 5000;

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

export interface Line {
    multipv: number;
    score: Score;
    pv: string[]; // UCI moves
}

export interface AnalysisResult {
    depth: number;
    // Sorted ascending by multipv; lines[0] is the engine's preferred line.
    lines: Line[];
}

export interface AnalyzeOptions {
    /** `go depth N`. Takes precedence over movetime if both are set. */
    depth?: number;
    /** `go movetime N` (ms). Defaults to PLAY_TIME_LIMIT_MS if depth is unset. */
    movetime?: number;
    multiPv?: number;
}

export interface Engine {
    bestMove(fen: string, onInfo?: (info: SearchInfo) => void): Promise<string>;
    analyze(fen: string, options?: AnalyzeOptions, onProgress?: (result: AnalysisResult) => void): Promise<AnalysisResult>;
    stop(): void;
    quit(): void;
}

interface PendingSearch {
    resolve: (move: string) => void;
    reject: (err: Error) => void;
    onMessage: (e: MessageEvent) => void;
}

interface RawInfo {
    depth: number;
    multipv: number;
    score: Score;
    pv: string[];
}

// Stockfish reports scores from the side-to-move's point of view. Normalise
// to White-positive here, at the boundary where the engine's answer enters
// the app, so nothing downstream has to think about whose turn it was.
function parseInfo(line: string, sideToMove: 'white' | 'black'): RawInfo | undefined {
    if (!line.startsWith('info ')) return undefined;
    const depthMatch = line.match(/ depth (\d+)/);
    const scoreMatch = line.match(/ score (cp|mate) (-?\d+)/);
    if (!depthMatch || !scoreMatch) return undefined;

    const multipvMatch = line.match(/ multipv (\d+)/);
    const pvMatch = line.match(/ pv (.+)$/);
    const sign = sideToMove === 'white' ? 1 : -1;
    const type = scoreMatch[1] as 'cp' | 'mate';
    const value = Number(scoreMatch[2]) * sign;
    return {
        depth: Number(depthMatch[1]),
        multipv: multipvMatch ? Number(multipvMatch[1]) : 1,
        score: { type, value },
        pv: pvMatch ? pvMatch[1].trim().split(' ') : [],
    };
}

export function startEngine(): Promise<Engine> {
    return new Promise((resolve) => {
        const worker = new Worker('/engine/stockfish-18-single.js');

        // At most one search in flight at a time. Sending `position`/`go` while
        // the engine is already searching can hang the wasm build outright.
        let pending: PendingSearch | null = null;

        const runSearch = (
            fen: string,
            goCommand: string,
            onRaw?: (info: RawInfo) => void,
        ): Promise<string> => {
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
                    } else if (onRaw) {
                        const info = parseInfo(line, sideToMove);
                        if (info) onRaw(info);
                    }
                };
                pending = { resolve: resolveMove, reject: rejectMove, onMessage };
                worker.addEventListener('message', onMessage);
                worker.postMessage(`position fen ${fen}`);
                worker.postMessage(goCommand);
            });
        };

        const bestMove = (fen: string, onInfo?: (info: SearchInfo) => void): Promise<string> => {
            worker.postMessage('setoption name MultiPV value 1');
            return runSearch(fen, `go movetime ${PLAY_TIME_LIMIT_MS}`, onInfo && ((raw) => onInfo({ depth: raw.depth, score: raw.score })));
        };

        const analyze = async (
            fen: string,
            options: AnalyzeOptions = {},
            onProgress?: (result: AnalysisResult) => void,
        ): Promise<AnalysisResult> => {
            const multiPv = options.multiPv ?? 1;
            worker.postMessage(`setoption name MultiPV value ${multiPv}`);

            const linesByIndex = new Map<number, Line>();
            let latestDepth = 0;
            const snapshot = (): AnalysisResult => ({
                depth: latestDepth,
                lines: [...linesByIndex.values()].sort((a, b) => a.multipv - b.multipv),
            });

            const goCommand = options.depth
                ? `go depth ${options.depth}`
                : `go movetime ${options.movetime ?? PLAY_TIME_LIMIT_MS}`;

            await runSearch(fen, goCommand, (raw) => {
                linesByIndex.set(raw.multipv, { multipv: raw.multipv, score: raw.score, pv: raw.pv });
                latestDepth = raw.depth;
                onProgress?.(snapshot());
            });
            return snapshot();
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
                resolve({ bestMove, analyze, stop, quit });
            }
        };

        worker.addEventListener('message', onReady);
        worker.postMessage('uci');
        worker.postMessage('isready');
    })
}
