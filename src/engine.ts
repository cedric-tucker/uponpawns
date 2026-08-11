const ENGINE_TIME_LIMIT_MS = 5000;

export interface Engine {
    bestMove(fen: string): Promise<string>;
    quit(): void
}


export function startEngine(): Promise<Engine> {
    return new Promise((resolve) => {
         const worker = new Worker('/engine/stockfish-18-single.js');

         const bestMove = (fen: string): Promise<string> => {
            return new Promise((resolveMove) => {
              const onMessage = (e:MessageEvent) => {
                const line = e.data as string;
                if (line.startsWith('bestmove')) {
                    worker.removeEventListener('message', onMessage);
                    resolveMove(line.split(' ')[1]);
                }
              };
              worker.addEventListener('message', onMessage);
              worker.postMessage(`position fen ${fen}`);
              worker.postMessage(`go movetime ${ENGINE_TIME_LIMIT_MS}`)
            });
         };
         
        const quit = () => worker.terminate();

         const onReady = (e:MessageEvent) => {
            if (e.data === 'readyok') {
                worker.removeEventListener('message', onReady);
                resolve({bestMove, quit});
            }
         };

         worker.addEventListener('message', onReady);
         worker.postMessage('uci');
         worker.postMessage('isready');
    })
}

