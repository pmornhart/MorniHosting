/**
 * A short burst of pixel confetti from a point on the screen (default: top middle). Plain DOM, removes itself;
 * hidden entirely for people who asked for less motion (motion.css).
 */
const PIECES = 46;
const COLOURS = ['#34d399', '#10b981', '#fbbf24', '#f87171', '#60a5fa', '#a78bfa', '#ffffff'];
const SPREAD_X = 520;
const RISE = 220;
const FALL = 520;
const MIN_TIME_MS = 900;
const EXTRA_TIME_MS = 900;
const FULL_TURN = 720;
const CLEANUP_MS = MIN_TIME_MS + EXTRA_TIME_MS + 200;

export function confetti(from?: { x: number; y: number }): void {
  if (typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const origin = from ?? { x: window.innerWidth / 2, y: window.innerHeight / 4 };
  const pieces = Array.from({ length: PIECES }, () => {
    const piece = document.createElement('span');
    piece.className = 'mh-confetti';
    piece.style.left = `${origin.x}px`;
    piece.style.top = `${origin.y}px`;
    piece.style.background = COLOURS[Math.floor(Math.random() * COLOURS.length)] ?? '#34d399';
    piece.style.setProperty('--dx', `${(Math.random() - 0.5) * SPREAD_X}px`);
    piece.style.setProperty('--dy', `${Math.random() * FALL - RISE}px`);
    piece.style.setProperty('--spin', `${(Math.random() - 0.5) * FULL_TURN}deg`);
    piece.style.setProperty('--time', `${MIN_TIME_MS + Math.random() * EXTRA_TIME_MS}ms`);
    document.body.appendChild(piece);
    return piece;
  });
  setTimeout(() => pieces.forEach((p) => p.remove()), CLEANUP_MS);
}
