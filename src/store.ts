// IndexedDB persistence. localStorage caps around 5MB and is synchronous;
// this app's card collection (with precomputed eval maps per card) will
// outgrow that fast.
import type { Card } from './review';

export interface SourceGame {
    id: string;
    pgn: string;
    headers: Record<string, string>;
    importedAt: string; // ISO
}

export interface Store {
    // Duplicates are expected to be rare but cheap to guard against: two
    // rows for the same position would mean two independent FSRS schedules
    // and the same position turning up twice in one session. Merges on
    // normalised FEN.
    addCard(card: Card): Promise<'inserted' | 'duplicate'>;
    updateCard(card: Card): Promise<void>;
    deleteCard(id: string): Promise<void>;
    getAllCards(): Promise<Card[]>;
    getDueCards(now: Date): Promise<Card[]>;
    addGame(game: SourceGame): Promise<void>;
    getGame(id: string): Promise<SourceGame | undefined>;
    exportAll(): Promise<string>;
    importAll(json: string): Promise<{ cardsAdded: number; cardsSkipped: number }>;
}

const DB_NAME = 'uponpawns';
const DB_VERSION = 1;
const CARDS_STORE = 'cards';
const GAMES_STORE = 'games';

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(CARDS_STORE)) {
                const cards = db.createObjectStore(CARDS_STORE, { keyPath: 'id' });
                cards.createIndex('by-fen', 'fen', { unique: true });
                cards.createIndex('by-due', 'fsrs.due');
            }
            if (!db.objectStoreNames.contains(GAMES_STORE)) {
                db.createObjectStore(GAMES_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// FSRS dates round-trip through JSON as strings; ts-fsrs expects real Date
// instances, so anything crossing that boundary (import, IDB deserialize of
// a value that was itself imported from JSON) needs this fix-up applied.
function reviveCard(card: Card): Card {
    return {
        ...card,
        fsrs: {
            ...card.fsrs,
            due: new Date(card.fsrs.due),
            last_review: card.fsrs.last_review ? new Date(card.fsrs.last_review) : undefined,
        },
    };
}

export async function openStore(): Promise<Store> {
    const db = await openDb();

    async function addCard(card: Card): Promise<'inserted' | 'duplicate'> {
        const tx = db.transaction(CARDS_STORE, 'readwrite');
        const store = tx.objectStore(CARDS_STORE);
        const existingKey = await reqToPromise(store.index('by-fen').getKey(card.fen));
        if (existingKey !== undefined) return 'duplicate';
        await reqToPromise(store.add(card));
        return 'inserted';
    }

    async function updateCard(card: Card): Promise<void> {
        const tx = db.transaction(CARDS_STORE, 'readwrite');
        await reqToPromise(tx.objectStore(CARDS_STORE).put(card));
    }

    async function deleteCard(id: string): Promise<void> {
        const tx = db.transaction(CARDS_STORE, 'readwrite');
        await reqToPromise(tx.objectStore(CARDS_STORE).delete(id));
    }

    async function getAllCards(): Promise<Card[]> {
        const tx = db.transaction(CARDS_STORE, 'readonly');
        return reqToPromise(tx.objectStore(CARDS_STORE).getAll());
    }

    async function getDueCards(now: Date): Promise<Card[]> {
        const tx = db.transaction(CARDS_STORE, 'readonly');
        const index = tx.objectStore(CARDS_STORE).index('by-due');
        return reqToPromise(index.getAll(IDBKeyRange.upperBound(now)));
    }

    async function addGame(game: SourceGame): Promise<void> {
        const tx = db.transaction(GAMES_STORE, 'readwrite');
        await reqToPromise(tx.objectStore(GAMES_STORE).put(game));
    }

    async function getGame(id: string): Promise<SourceGame | undefined> {
        const tx = db.transaction(GAMES_STORE, 'readonly');
        return reqToPromise(tx.objectStore(GAMES_STORE).get(id));
    }

    async function exportAll(): Promise<string> {
        const tx = db.transaction([CARDS_STORE, GAMES_STORE], 'readonly');
        const cards = await reqToPromise(tx.objectStore(CARDS_STORE).getAll());
        const games = await reqToPromise(tx.objectStore(GAMES_STORE).getAll());
        return JSON.stringify({ version: 1, cards, games });
    }

    async function importAll(json: string): Promise<{ cardsAdded: number; cardsSkipped: number }> {
        const data = JSON.parse(json) as { cards: Card[]; games: SourceGame[] };
        for (const game of data.games ?? []) {
            await addGame(game);
        }
        let cardsAdded = 0;
        let cardsSkipped = 0;
        for (const rawCard of data.cards ?? []) {
            const result = await addCard(reviveCard(rawCard));
            if (result === 'inserted') cardsAdded++;
            else cardsSkipped++;
        }
        return { cardsAdded, cardsSkipped };
    }

    return { addCard, updateCard, deleteCard, getAllCards, getDueCards, addGame, getGame, exportAll, importAll };
}
