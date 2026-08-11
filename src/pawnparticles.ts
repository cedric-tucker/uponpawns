// A field of small particles arranged as a surface of revolution shaped
// like a pawn -- the same technique behind the classic "spinning donut"
// demo: a 2D profile curve (radius vs. height) revolved around the
// vertical axis, then rotated and projected each frame.
//
// The pointer knocks nearby particles into a genuine free flight: while a
// particle carries real speed, its pull back toward its rotating seat is
// almost entirely switched off, and it instead bounces off the canvas
// edges like a pong ball, losing a little energy each bounce. Only once
// it's slowed back down does the spring take back over and reel it in.
interface Particle {
    t: number; // normalised height, fixed for this particle's lifetime
    phi: number; // angular seat around the vertical axis, fixed
    x: number; // current on-screen position
    y: number;
    vx: number;
    vy: number;
}

interface Seed {
    t: number;
    phi: number;
}

const PARTICLE_COUNT = 900; // backface-culled, so only roughly half are ever visible at once
const DOT_RADIUS_MIN = 0.6;
const DOT_RADIUS_MAX = 1.3;
const ROTATION_SPEED = 0.006; // radians/frame at ~60fps -- one turn every ~17s
const SPRING = 0.06;
const FRICTION = 0.95; // light drag -- particles should actually travel and bounce, not just fizzle
const KICK_RADIUS = 46;
const KICK_STRENGTH = 15; // a real knock
const MAX_SPEED = 16; // clamp so sustained cursor proximity can't accelerate a particle without bound
const CALM_SPEED = 5; // below this, the spring progressively re-engages; above it, the particle is free-flying
const WALL_RESTITUTION = 0.86; // energy kept per bounce off the container edge

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

export function mountPawnParticles(canvas: HTMLCanvasElement, dotColor: string): ParticleField {
    const ctx = canvas.getContext('2d');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let seeds: Seed[] = [];
    let particles: Particle[] = [];
    let rotation = 0;
    let pointer: { x: number; y: number } | null = null;
    let raf = 0;

    function project(t: number, phi: number): { x: number; y: number; z: number } {
        const scale = Math.min(width, height);
        const r = pawnRadius(t) * scale;
        const theta = phi + rotation;
        const x3 = r * Math.cos(theta);
        const z3 = r * Math.sin(theta);
        const y3 = (0.5 - t) * scale * 0.78; // taller than wide, vertically centered
        return { x: width / 2 + x3, y: height / 2 + y3, z: z3 };
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
        if (seeds.length === 0) {
            seeds = seedParticles(PARTICLE_COUNT);
            particles = seeds.map(({ t, phi }) => {
                const p = project(t, phi);
                return { t, phi, x: p.x, y: p.y, vx: 0, vy: 0 };
            });
        }
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

    function depthStyle(z: number): { alpha: number; radius: number } {
        const norm = Math.max(-1, Math.min(1, z / (Math.min(width, height) * 0.32)));
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
        return z >= -Math.min(width, height) * 0.02;
    }

    // A single still frame for prefers-reduced-motion: particles drawn
    // directly at their seat, no spring, no rotation, no loop.
    function drawStatic() {
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = dotColor;
        const projected = particles.map((p) => project(p.t, p.phi)).filter((d) => isFacing(d.z));
        projected.sort((a, b) => a.z - b.z);
        for (const d of projected) drawDot(d.x, d.y, d.z);
        ctx.globalAlpha = 1;
    }

    function step() {
        rotation += ROTATION_SPEED;
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = dotColor;

        // Physics runs for every particle regardless of facing, so one
        // rotating back into view is already tracking its target smoothly
        // instead of jump-cutting in from a frozen position.
        const targets = particles.map((p) => ({ p, target: project(p.t, p.phi) }));

        for (const { p, target } of targets) {
            const speed = Math.hypot(p.vx, p.vy);
            // 1 = calm (spring fully engaged), 0 = still flying from a knock.
            const calm = Math.max(0, Math.min(1, 1 - speed / CALM_SPEED));
            let ax = (target.x - p.x) * SPRING * calm;
            let ay = (target.y - p.y) * SPRING * calm;
            if (pointer) {
                const dx = p.x - pointer.x;
                const dy = p.y - pointer.y;
                const dist = Math.hypot(dx, dy) || 1;
                if (dist < KICK_RADIUS) {
                    const force = (1 - dist / KICK_RADIUS) * KICK_STRENGTH;
                    ax += (dx / dist) * force;
                    ay += (dy / dist) * force;
                }
            }
            p.vx = (p.vx + ax) * FRICTION;
            p.vy = (p.vy + ay) * FRICTION;

            const newSpeed = Math.hypot(p.vx, p.vy);
            if (newSpeed > MAX_SPEED) {
                p.vx = (p.vx / newSpeed) * MAX_SPEED;
                p.vy = (p.vy / newSpeed) * MAX_SPEED;
            }

            p.x += p.vx;
            p.y += p.vy;

            // Bounce off the container edges like a pong ball, losing a
            // little speed each time, rather than escaping the canvas.
            if (p.x < 0) {
                p.x = 0;
                p.vx = -p.vx * WALL_RESTITUTION;
            } else if (p.x > width) {
                p.x = width;
                p.vx = -p.vx * WALL_RESTITUTION;
            }
            if (p.y < 0) {
                p.y = 0;
                p.vy = -p.vy * WALL_RESTITUTION;
            } else if (p.y > height) {
                p.y = height;
                p.vy = -p.vy * WALL_RESTITUTION;
            }
        }

        const visible = targets.filter(({ target }) => isFacing(target.z));
        visible.sort((a, b) => a.target.z - b.target.z); // back-to-front
        for (const { p, target } of visible) drawDot(p.x, p.y, target.z);
        ctx.globalAlpha = 1;

        raf = requestAnimationFrame(step);
    }

    function resume() {
        ensureSized();
        if (raf) return;
        if (reducedMotion) {
            drawStatic();
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
