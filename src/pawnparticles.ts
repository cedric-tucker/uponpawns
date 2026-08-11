// A field of small particles resting in the shape of a pawn. The pointer
// pushes nearby particles away; a spring pulls each one back toward its
// resting position once released. Runs only while visible -- pause()/
// resume() are wired to Home screen visibility by the caller, since an
// animation loop behind a hidden screen is pure waste.
interface Particle {
    homeX: number;
    homeY: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
}

const REPEL_RADIUS = 46;
const REPEL_STRENGTH = 2600;
const SPRING = 0.035;
const FRICTION = 0.88;
const DOT_RADIUS = 1.6;
const MAX_PARTICLES = 340;
const SAMPLE_STEP = 4;

export interface ParticleField {
    pause(): void;
    resume(): void;
}

// Drawn from primitives rather than a font glyph -- chess symbol coverage
// varies enough across platforms that betting the whole effect on a font
// having U+2659 felt too fragile. Segmented (base / body / neck / collar /
// head) with real gaps in radius between them so it still reads as a pawn
// once blurred out into a sparse dot field.
function drawPawnSilhouette(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const cx = width / 2;
    ctx.fillStyle = '#fff';

    // Base
    ctx.beginPath();
    ctx.ellipse(cx, height * 0.90, width * 0.32, height * 0.055, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body: a rounded cone from the base up to the neck
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.24, height * 0.86);
    ctx.quadraticCurveTo(cx - width * 0.26, height * 0.62, cx - width * 0.075, height * 0.52);
    ctx.lineTo(cx + width * 0.075, height * 0.52);
    ctx.quadraticCurveTo(cx + width * 0.26, height * 0.62, cx + width * 0.24, height * 0.86);
    ctx.closePath();
    ctx.fill();

    // Neck -- deliberately thin, so the collar above reads as an overhang
    ctx.beginPath();
    ctx.moveTo(cx - width * 0.06, height * 0.52);
    ctx.lineTo(cx - width * 0.055, height * 0.42);
    ctx.lineTo(cx + width * 0.055, height * 0.42);
    ctx.lineTo(cx + width * 0.06, height * 0.52);
    ctx.closePath();
    ctx.fill();

    // Collar
    ctx.beginPath();
    ctx.ellipse(cx, height * 0.41, width * 0.115, height * 0.028, 0, 0, Math.PI * 2);
    ctx.fill();

    // Head
    ctx.beginPath();
    ctx.arc(cx, height * 0.24, width * 0.15, 0, Math.PI * 2);
    ctx.fill();
}

function samplePoints(width: number, height: number): { x: number; y: number }[] {
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d');
    if (!ctx) return [];
    drawPawnSilhouette(ctx, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const all: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y += SAMPLE_STEP) {
        for (let x = 0; x < width; x += SAMPLE_STEP) {
            if (data[(y * width + x) * 4 + 3] > 128) all.push({ x, y });
        }
    }
    if (all.length <= MAX_PARTICLES) return all;
    // Shuffle before truncating: the grid above is filled row-major, so
    // taking a fixed stride through it unshuffled picks a diagonal,
    // wavy-looking subset instead of an even scatter across the shape.
    for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, MAX_PARTICLES);
}

export function mountPawnParticles(canvas: HTMLCanvasElement, dotColor: string): ParticleField {
    const ctx = canvas.getContext('2d');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let pointer: { x: number; y: number } | null = null;
    let raf = 0;

    function ensureSized() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w === 0 || h === 0) return; // not visible yet -- nothing to size against
        if (w === width && h === height && particles.length) return;
        width = w;
        height = h;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        particles = samplePoints(width, height).map((p) => ({ homeX: p.x, homeY: p.y, x: p.x, y: p.y, vx: 0, vy: 0 }));
    }

    function onPointerMove(e: PointerEvent) {
        const rect = canvas.getBoundingClientRect();
        pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    function onPointerLeave() {
        pointer = null;
    }
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    function drawFrame() {
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = dotColor;
        for (const p of particles) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function step() {
        for (const p of particles) {
            let ax = (p.homeX - p.x) * SPRING;
            let ay = (p.homeY - p.y) * SPRING;
            if (pointer) {
                const dx = p.x - pointer.x;
                const dy = p.y - pointer.y;
                const dist = Math.hypot(dx, dy) || 1;
                if (dist < REPEL_RADIUS) {
                    const force = (1 - dist / REPEL_RADIUS) * (REPEL_STRENGTH / (dist * dist + 40));
                    ax += (dx / dist) * force;
                    ay += (dy / dist) * force;
                }
            }
            p.vx = (p.vx + ax) * FRICTION;
            p.vy = (p.vy + ay) * FRICTION;
            p.x += p.vx;
            p.y += p.vy;
        }
        drawFrame();
        raf = requestAnimationFrame(step);
    }

    function resume() {
        ensureSized();
        if (raf) return;
        if (reducedMotion) {
            drawFrame();
        } else {
            raf = requestAnimationFrame(step);
        }
    }
    function pause() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    return { pause, resume };
}
