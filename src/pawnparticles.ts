// A field of small particles arranged as a surface of revolution shaped
// like a pawn -- the same technique behind the classic "spinning donut"
// demo: a 2D profile curve (radius vs. height) revolved around the
// vertical axis, then rotated on two axes and projected each frame.
//
// The pawn is one rigid, cohesive shape (particles carry no state of
// their own -- every frame each is drawn exactly at its computed
// position). Two independent things have physics: a shared (center,
// velocity) for the whole shape's position, which the pointer knocks and
// which bounces off the *canvas's* edges (the whole home screen, not the
// shape's own small box) like a pong ball before easing back to its
// resting spot; and a spin velocity around the vertical axis, which
// dragging the pointer left/right speeds up, slows down, or reverses.
interface Seed {
    t: number; // normalised height, fixed for this particle's lifetime
    phi: number; // angular seat around the vertical axis, fixed
}

const PARTICLE_COUNT = 900; // backface-culled, so only roughly half are ever visible at once
const DOT_RADIUS_MIN = 0.6;
const DOT_RADIUS_MAX = 1.3;

// Rotation: two axes so it actually tumbles instead of just spinning flat
// like a lathe. Y is the "spin" (interactive); X is a slow constant
// "tumble" that's always running, which is what makes it read as a real
// 3D object rather than a disc.
const SPIN_BASE_SPEED = 0.006; // rad/frame the Y spin eases back to when not being dragged
const TUMBLE_SPEED = 0.0016; // rad/frame, constant, around X
const SPIN_SENSITIVITY = 0.0026; // how much horizontal drag speed adds to the Y spin velocity
const SPIN_DECAY = 0.02; // how quickly the Y spin eases back toward baseline after a drag
const MAX_SPIN_SPEED = 0.09;

const HIT_RADIUS_FACTOR = 0.62; // x pawnScale -- how close counts as "touching" the pawn
const KICK_STRENGTH = 2.4;
const MAX_CENTER_SPEED = 11;
const FRICTION = 0.985; // light drag -- the shape should travel and bounce, not fizzle in place
const WALL_RESTITUTION = 0.82; // energy kept per bounce off the container edge
const CALM_SPEED = 0.6; // below this, the shape eases back toward its resting spot
const REST_SPRING = 0.01;

export interface ParticleField {
    pause(): void;
    resume(): void;
}

// ---- Pawn profile: radius as a function of normalised height (0 = base
// underside, 1 = crown of the head). Named, physically-motivated segments
// rather than an arbitrary blob -- and real circular-arc math for the
// head, so it actually reads as a ball once revolved. ----
const PROFILE: [number, number][] = [
    [0.00, 0.00],
    [0.02, 0.30],
    [0.07, 0.28],
    [0.11, 0.19],
    [0.30, 0.145],
    [0.44, 0.135],
    [0.47, 0.205],
    [0.51, 0.115],
    [0.58, 0.078],
    [0.68, 0.115],
    [0.80, 0.160],
];
const HEAD_EQUATOR_T = 0.80;
const HEAD_R = 0.160;
const PROFILE_MAX_R = 0.30;
const PAWN_HALF_HEIGHT_FACTOR = 0.39; // half of the 0.78 height scale below

function lerpCos(a: number, b: number, mu: number): number {
    const eased = (1 - Math.cos(mu * Math.PI)) / 2;
    return a + (b - a) * eased;
}

function pawnRadius(t: number): number {
    if (t >= HEAD_EQUATOR_T) {
        const local = (t - HEAD_EQUATOR_T) / (1 - HEAD_EQUATOR_T);
        return HEAD_R * Math.cos(local * (Math.PI / 2));
    }
    for (let i = 0; i < PROFILE.length - 1; i++) {
        const [t0, r0] = PROFILE[i];
        const [t1, r1] = PROFILE[i + 1];
        if (t >= t0 && t <= t1) return lerpCos(r0, r1, (t - t0) / (t1 - t0));
    }
    return PROFILE[PROFILE.length - 1][1];
}

// Rejection sampling with acceptance probability proportional to radius
// approximates uniform density per unit of actual surface (circumference
// scales with radius), so the wide base and head don't come out sparser
// than the thin neck just because they got the same point count.
function seedParticles(count: number): Seed[] {
    const seeds: Seed[] = [];
    let guard = 0;
    while (seeds.length < count && guard < count * 80) {
        guard++;
        const t = Math.random();
        if (Math.random() * PROFILE_MAX_R < pawnRadius(t)) {
            seeds.push({ t, phi: Math.random() * Math.PI * 2 });
        }
    }
    return seeds;
}

export function mountPawnParticles(canvas: HTMLCanvasElement, anchor: HTMLElement, dotColor: string): ParticleField {
    const ctx = canvas.getContext('2d');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0; // canvas (whole home screen) bounds -- the bounce arena
    let height = 0;
    let pawnScale = 0; // the shape's own size, from the anchor element, independent of the arena size
    let seeds: Seed[] = [];
    let seeded = false;

    let spinY = 0;
    let spinVelY = SPIN_BASE_SPEED;
    let tumbleX = 0;

    // The whole shape's offset from the canvas's top-left, and its
    // velocity -- the only thing with position physics. Every particle's
    // position is purely a function of (spinY, tumbleX, center); there's
    // no per-particle state.
    const center = { x: 0, y: 0 };
    const centerV = { x: 0, y: 0 };
    const restOffset = { x: 0, y: 0 }; // where the anchor currently sits, in canvas-relative coords

    let pointer: { x: number; y: number } | null = null;
    let raf = 0;

    function project(t: number, phi: number): { x: number; y: number; z: number } {
        const r = pawnRadius(t) * pawnScale;
        const x0 = r * Math.cos(phi);
        const z0 = r * Math.sin(phi);
        const y0 = (0.5 - t) * pawnScale * 0.78; // taller than wide

        // Spin around the vertical (Y) axis.
        const x1 = x0 * Math.cos(spinY) - z0 * Math.sin(spinY);
        const z1 = x0 * Math.sin(spinY) + z0 * Math.cos(spinY);

        // Tumble around the horizontal (X) axis -- what keeps this from
        // looking like a flat disc spinning in place.
        const y2 = y0 * Math.cos(tumbleX) - z1 * Math.sin(tumbleX);
        const z2 = y0 * Math.sin(tumbleX) + z1 * Math.cos(tumbleX);

        return { x: center.x + x1, y: center.y + y2, z: z2 };
    }

    function ensureSized() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w === 0 || h === 0) return; // not visible yet
        if (w !== width || h !== height) {
            width = w;
            height = h;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        const anchorRect = anchor.getBoundingClientRect();
        if (anchorRect.width > 0) {
            pawnScale = anchorRect.width;
            restOffset.x = anchorRect.left + anchorRect.width / 2 - rect.left;
            restOffset.y = anchorRect.top + anchorRect.height / 2 - rect.top;
        }

        if (!seeded && pawnScale > 0) {
            seeds = seedParticles(PARTICLE_COUNT);
            center.x = restOffset.x;
            center.y = restOffset.y;
            seeded = true;
        }
    }

    function onPointerMove(e: PointerEvent) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (pointer && pawnScale > 0) {
            const dist = Math.hypot(x - center.x, y - center.y);
            if (dist < pawnScale * HIT_RADIUS_FACTOR) {
                spinVelY += (x - pointer.x) * SPIN_SENSITIVITY;
                spinVelY = Math.max(-MAX_SPIN_SPEED, Math.min(MAX_SPIN_SPEED, spinVelY));
            }
        }
        pointer = { x, y };
    }
    function onPointerLeave() {
        pointer = null;
    }
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    function depthStyle(z: number): { alpha: number; radius: number } {
        const norm = Math.max(-1, Math.min(1, z / (pawnScale * 0.32)));
        const t = (norm + 1) / 2;
        return { alpha: 0.35 + t * 0.65, radius: DOT_RADIUS_MIN + t * (DOT_RADIUS_MAX - DOT_RADIUS_MIN) };
    }

    function drawDot(x: number, y: number, z: number) {
        if (!ctx) return;
        const { alpha, radius } = depthStyle(z);
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    // A solid pawn only ever shows the surface facing the viewer -- without
    // this, points from all the way around the revolution overlap in 2D
    // and it reads as a fuzzy blob rather than a rotating solid. A small
    // negative allowance rather than a hard z >= 0 keeps a sliver of the
    // rim visible right at the silhouette edge instead of a clean cut.
    function isFacing(z: number): boolean {
        return z >= -pawnScale * 0.02;
    }

    function drawShape() {
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = dotColor;
        const projected = seeds.map(({ t, phi }) => project(t, phi)).filter((d) => isFacing(d.z));
        projected.sort((a, b) => a.z - b.z); // back-to-front
        for (const d of projected) drawDot(d.x, d.y, d.z);
        ctx.globalAlpha = 1;
    }

    // Knocks and settles the *whole shape*, not individual particles.
    function stepCenter() {
        if (pointer) {
            const dx = center.x - pointer.x;
            const dy = center.y - pointer.y;
            const dist = Math.hypot(dx, dy) || 1;
            const hitRadius = pawnScale * HIT_RADIUS_FACTOR;
            if (dist < hitRadius) {
                const force = (1 - dist / hitRadius) * KICK_STRENGTH;
                centerV.x += (dx / dist) * force;
                centerV.y += (dy / dist) * force;
            }
        }

        const speed = Math.hypot(centerV.x, centerV.y);
        if (speed < CALM_SPEED) {
            centerV.x += (restOffset.x - center.x) * REST_SPRING;
            centerV.y += (restOffset.y - center.y) * REST_SPRING;
        }

        centerV.x *= FRICTION;
        centerV.y *= FRICTION;
        const sp = Math.hypot(centerV.x, centerV.y);
        if (sp > MAX_CENTER_SPEED) {
            centerV.x = (centerV.x / sp) * MAX_CENTER_SPEED;
            centerV.y = (centerV.y / sp) * MAX_CENTER_SPEED;
        }

        center.x += centerV.x;
        center.y += centerV.y;

        // Bounce off the *canvas's* edges (the whole home screen) once the
        // shape's own extent reaches the wall, not just its centre point.
        const halfW = PROFILE_MAX_R * pawnScale;
        const halfH = pawnScale * PAWN_HALF_HEIGHT_FACTOR;
        if (center.x < halfW) {
            center.x = halfW;
            centerV.x = -centerV.x * WALL_RESTITUTION;
        } else if (center.x > width - halfW) {
            center.x = width - halfW;
            centerV.x = -centerV.x * WALL_RESTITUTION;
        }
        if (center.y < halfH) {
            center.y = halfH;
            centerV.y = -centerV.y * WALL_RESTITUTION;
        } else if (center.y > height - halfH) {
            center.y = height - halfH;
            centerV.y = -centerV.y * WALL_RESTITUTION;
        }
    }

    function stepRotation() {
        spinVelY += (SPIN_BASE_SPEED - spinVelY) * SPIN_DECAY;
        spinY += spinVelY;
        tumbleX += TUMBLE_SPEED;
    }

    function step() {
        stepRotation();
        stepCenter();
        drawShape();
        raf = requestAnimationFrame(step);
    }

    function resume() {
        ensureSized();
        if (raf) return;
        if (reducedMotion) {
            drawShape(); // single static frame -- no rotation, no bounce, no loop
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
