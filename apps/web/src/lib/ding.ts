/**
 * Attention chime for finished runs: plays a short synthesized "ding" when a
 * run stops (completes, fails, or waits for the user) while the user is away
 * from CodeFly — the tab is hidden or the window lost focus. Stays silent
 * whenever the page is visible and focused.
 */

let audioContext: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioContext === null) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
  }
  // Autoplay policy keeps the context suspended until user activation; the
  // user has always interacted with the page before a run starts, so resume
  // is enough. Best-effort: a rejected resume just means no sound.
  if (audioContext.state === "suspended") {
    void audioContext.resume().catch(() => undefined);
  }
  return audioContext;
}

function pageActive(): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

/** Plays the ding, but only when the user is away from CodeFly. */
export function dingWhenAway(): void {
  try {
    if (pageActive()) return;
    const ctx = ensureAudioContext();
    if (!ctx || ctx.state === "closed") return;

    const now = ctx.currentTime;
    // Loud attack pushed into a soft limiter: clearly audible from across the
    // room, but the ceiling keeps the chime from clipping harshly.
    const master = ctx.createGain();
    master.gain.value = 1;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    master.connect(limiter);

    // Single-playback output already sits at digital full scale, so the extra
    // loudness is perceptual: a brighter, denser bell (2–3.5 kHz is the ear's
    // most sensitive band) struck twice.
    strike(ctx, master, now);
    strike(ctx, master, now + 0.22);
  } catch {
    // The chime is best-effort; never let it break a run's bookkeeping.
  }
}

/** One bell strike: A6 fundamental, its fifth (E7) and an octave sparkle. */
function strike(ctx: AudioContext, master: GainNode, at: number): void {
  const partials: Array<{ freq: number; gain: number; decay: number }> = [
    { freq: 1760, gain: 1.4, decay: 0.7 },
    { freq: 2637, gain: 0.9, decay: 0.55 },
    { freq: 3520, gain: 0.5, decay: 0.4 },
  ];
  for (const { freq, gain, decay } of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(envelope);
    envelope.connect(master);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }
}
