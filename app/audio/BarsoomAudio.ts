export type TraverseAudioEvent =
  | { type: "step"; running: boolean }
  | { type: "jump" }
  | { type: "land" }
  | { type: "suitThruster"; active: boolean }
  | { type: "warp" }
  | { type: "flight"; active: boolean; throttle: number; boost: boolean; maneuver: number };

export type FlightAudioState = {
  active: boolean;
  throttle: number;
  boost: boolean;
};

export function flightAudioTargets(state: FlightAudioState) {
  if (!state.active) return { engine: 0, booster: 0 };
  const thrust = Math.max(0, Math.min(1, Math.abs(state.throttle)));
  return {
    engine: 0.055 + thrust * 0.2,
    booster: state.boost && thrust > 0.04 ? 0.46 : 0,
  };
}

export function landingAudioTargets(narrationActive: boolean) {
  const gain = narrationActive ? 0.72 : 1;
  return {
    impactVolume: 0.92 * gain,
    suitContactVolume: 0.34 * gain,
  };
}

export function suitThrusterAudioTarget(active: boolean, narrationActive: boolean) {
  if (!active) return 0;
  return 0.42 * (narrationActive ? 0.58 : 1);
}

type StepEffectId = "stepA" | "stepB" | "stepC" | "stepD" | "stepE" | "stepF";
type EffectId = StepEffectId | "jump" | "land" | "phaseLock" | "observerTransition" | "boostIgnite" | "thrusterBurst";

const STEP_EFFECT_IDS: StepEffectId[] = ["stepA", "stepB", "stepC", "stepD", "stepE", "stepF"];

const AUDIO_PATHS = {
  wind: "/audio/mars-wind-loop.mp3",
  score: "/audio/barsoom-survey-score.mp3",
  engine: "/audio/spacecraft-engine-loop.mp3",
  booster: "/audio/spacecraft-boost-loop.mp3",
  suitThruster: "/audio/spacecraft-boost-loop.mp3",
  stepA: "/audio/boot-step-a.mp3",
  stepB: "/audio/boot-step-b.mp3",
  stepC: "/audio/boot-step-c.mp3",
  stepD: "/audio/boot-step-d.mp3",
  stepE: "/audio/boot-step-e.mp3",
  stepF: "/audio/boot-step-f.mp3",
  jump: "/audio/jump-launch.mp3",
  land: "/audio/suit-land.mp3",
  phaseLock: "/audio/phase-lock.mp3",
  observerTransition: "/audio/observer-transition.mp3",
  boostIgnite: "/audio/spacecraft-boost-ignite.mp3",
  thrusterBurst: "/audio/spacecraft-thruster-burst.mp3",
} as const;

const MUTE_STORAGE_KEY = "barsoom.audio-muted";

function createAudio(source: string, loop = false) {
  const audio = new Audio(source);
  audio.preload = "auto";
  audio.loop = loop;
  return audio;
}

/**
 * Lightweight browser audio mixer for ambience, score, UI sonification and
 * third-person foley. Playback is unlocked by the first user gesture so the
 * experience stays within browser autoplay policy.
 */
export class BarsoomAudio {
  private readonly wind = createAudio(AUDIO_PATHS.wind, true);
  private readonly score = createAudio(AUDIO_PATHS.score, true);
  private readonly engine = createAudio(AUDIO_PATHS.engine, true);
  private readonly booster = createAudio(AUDIO_PATHS.booster, true);
  private readonly suitThruster = createAudio(AUDIO_PATHS.suitThruster, true);
  private readonly effects: Record<EffectId, HTMLAudioElement[]> = {
    stepA: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.stepA)),
    stepB: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.stepB)),
    stepC: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.stepC)),
    stepD: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.stepD)),
    stepE: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.stepE)),
    stepF: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.stepF)),
    jump: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.jump)),
    land: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.land)),
    phaseLock: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.phaseLock)),
    observerTransition: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.observerTransition)),
    boostIgnite: Array.from({ length: 2 }, () => createAudio(AUDIO_PATHS.boostIgnite)),
    thrusterBurst: Array.from({ length: 3 }, () => createAudio(AUDIO_PATHS.thrusterBurst)),
  };
  private readonly effectIndices: Record<EffectId, number> = {
    stepA: 0,
    stepB: 0,
    stepC: 0,
    stepD: 0,
    stepE: 0,
    stepF: 0,
    jump: 0,
    land: 0,
    phaseLock: 0,
    observerTransition: 0,
    boostIgnite: 0,
    thrusterBurst: 0,
  };
  private unlocked = false;
  private muted = false;
  private surfaceMode = false;
  private narrationActive = false;
  private stepBag: StepEffectId[] = [];
  private lastStep: StepEffectId | null = null;
  private windVolume = 0;
  private scoreVolume = 0;
  private engineVolume = 0;
  private boosterVolume = 0;
  private suitThrusterVolume = 0;
  private flightActive = false;
  private flightThrottle = 0;
  private flightBoost = false;
  private flightManeuver = false;
  private suitThrusterActive = false;
  private disposed = false;

  constructor() {
    try {
      this.muted = window.localStorage.getItem(MUTE_STORAGE_KEY) === "true";
    } catch {
      // Storage can be unavailable in privacy-restricted browsing contexts.
    }
    this.wind.volume = 0;
    this.score.volume = 0;
    this.engine.volume = 0;
    this.booster.volume = 0;
    this.suitThruster.volume = 0;
    window.addEventListener("pointerdown", this.onFirstInteraction, { capture: true });
    window.addEventListener("keydown", this.onFirstInteraction, { capture: true });
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  isMuted() {
    return this.muted;
  }

  setMuted(muted: boolean) {
    if (this.muted === muted) return;
    this.muted = muted;
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, String(muted));
    } catch {
      // Muting remains effective for this session even without storage.
    }
    if (muted) {
      this.pauseAll();
    } else {
      this.unlock();
    }
  }

  setSurfaceMode(active: boolean) {
    this.surfaceMode = active;
  }

  setNarrationActive(active: boolean) {
    this.narrationActive = active;
  }

  update(deltaSeconds: number) {
    if (this.muted || !this.unlocked || document.hidden) return;
    const blend = 1 - Math.exp(-Math.max(0, deltaSeconds) * 1.8);
    const narrationDuck = this.narrationActive ? 0.08 : 1;
    const windTarget = (this.flightActive ? 0.025 : this.surfaceMode ? 0.26 : 0.075) * narrationDuck;
    const scoreTarget = (this.flightActive ? 0.055 : this.surfaceMode ? 0.085 : 0.135) * narrationDuck;
    const flightTargets = flightAudioTargets({
      active: this.flightActive,
      throttle: this.flightThrottle,
      boost: this.flightBoost,
    });
    this.windVolume += (windTarget - this.windVolume) * blend;
    this.scoreVolume += (scoreTarget - this.scoreVolume) * blend;
    this.engineVolume += (flightTargets.engine * narrationDuck - this.engineVolume) * blend;
    this.boosterVolume += (flightTargets.booster * narrationDuck - this.boosterVolume) * blend;
    const suitThrusterTarget = suitThrusterAudioTarget(this.suitThrusterActive, this.narrationActive);
    const suitThrusterBlend = 1 - Math.exp(-Math.max(0, deltaSeconds) * 14);
    this.suitThrusterVolume += (suitThrusterTarget - this.suitThrusterVolume) * suitThrusterBlend;
    this.wind.volume = this.windVolume;
    this.score.volume = this.scoreVolume;
    this.engine.volume = this.engineVolume;
    this.booster.volume = this.boosterVolume;
    this.suitThruster.volume = this.suitThrusterVolume;
    this.engine.playbackRate = 0.88 + Math.min(1, Math.abs(this.flightThrottle)) * 0.22;
    this.booster.playbackRate = 0.98 + Math.min(1, Math.abs(this.flightThrottle)) * 0.08;
    this.suitThruster.playbackRate = 1.34;
  }

  handleTraverseEvent(event: TraverseAudioEvent) {
    if (event.type === "flight") {
      const throttle = Math.max(-1, Math.min(1, event.throttle));
      const boost = event.active && event.boost && Math.abs(throttle) > 0.04;
      const maneuver = event.active && Math.max(0, Math.min(1, event.maneuver)) > 0.08;
      if (boost && !this.flightBoost) this.playEffect("boostIgnite", 0.68, 1);
      if (maneuver && !this.flightManeuver) this.playEffect("thrusterBurst", 0.36, 1);
      this.flightActive = event.active;
      this.flightThrottle = event.active ? throttle : 0;
      this.flightBoost = boost;
      this.flightManeuver = maneuver;
      return;
    }
    if (event.type === "warp") {
      this.playEffect("boostIgnite", 0.95, 0.62);
      this.playEffect("observerTransition", 0.72, 0.55);
      this.playEffect("thrusterBurst", 0.7, 0.74);
      return;
    }
    if (event.type === "suitThruster") {
      if (event.active && !this.suitThrusterActive) {
        this.playEffect("thrusterBurst", 0.52 * (this.narrationActive ? 0.58 : 1), 1.42);
      }
      this.suitThrusterActive = event.active;
      return;
    }
    // Physical feedback should remain audible during SOVA narration. Duck it
    // instead of suppressing it entirely, otherwise early jumps have no
    // touchdown cue while the surface briefing is still playing.
    const narrationFoleyGain = this.narrationActive ? 0.42 : 1;

    if (event.type === "step") {
      const volume = (event.running ? 0.25 : 0.2) * narrationFoleyGain * (0.95 + Math.random() * 0.08);
      const playbackRate = (event.running ? 1.02 : 0.99) + (Math.random() - 0.5) * 0.025;
      this.playEffect(this.nextStepEffect(), volume, playbackRate);
    } else if (event.type === "jump") {
      this.playEffect("jump", 0.42 * narrationFoleyGain, 1);
    } else if (event.type === "land") {
      const touchdown = landingAudioTargets(this.narrationActive);
      this.playEffect("land", touchdown.impactVolume, 0.9);
      this.playEffect("stepC", touchdown.suitContactVolume, 0.76);
    }
  }

  playPhaseLock() {
    this.playEffect("phaseLock", 0.34, 1);
  }

  playObserverTransition(enteringSurface: boolean) {
    this.playEffect("observerTransition", 0.48, enteringSurface ? 1 : 0.84);
  }

  private nextStepEffect() {
    if (this.stepBag.length === 0) {
      const nextBag = [...STEP_EFFECT_IDS];
      for (let index = nextBag.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [nextBag[index], nextBag[swapIndex]] = [nextBag[swapIndex], nextBag[index]];
      }
      if (this.lastStep && nextBag.at(-1) === this.lastStep) {
        [nextBag[0], nextBag[nextBag.length - 1]] = [nextBag[nextBag.length - 1], nextBag[0]];
      }
      this.stepBag = nextBag;
    }
    const next = this.stepBag.pop() ?? "stepA";
    this.lastStep = next;
    return next;
  }

  private onFirstInteraction = () => {
    this.unlock();
  };

  private unlock() {
    if (this.disposed) return;
    this.unlocked = true;
    window.removeEventListener("pointerdown", this.onFirstInteraction, { capture: true });
    window.removeEventListener("keydown", this.onFirstInteraction, { capture: true });
    if (!this.muted && !document.hidden) this.startLoops();
  }

  private startLoops() {
    for (const audio of [this.wind, this.score, this.engine, this.booster, this.suitThruster]) {
      if (!audio.paused) continue;
      void audio.play().catch(() => {
        // A later user interaction can retry if a browser blocks this gesture.
        this.unlocked = false;
        window.addEventListener("pointerdown", this.onFirstInteraction, { capture: true });
        window.addEventListener("keydown", this.onFirstInteraction, { capture: true });
      });
    }
  }

  private playEffect(id: EffectId, volume: number, playbackRate: number) {
    if (!this.unlocked || this.muted || this.disposed || document.hidden) return;
    const pool = this.effects[id];
    const index = this.effectIndices[id] % pool.length;
    this.effectIndices[id] = index + 1;
    const audio = pool[index];
    audio.pause();
    audio.currentTime = 0;
    audio.volume = volume;
    audio.playbackRate = playbackRate;
    void audio.play().catch(() => undefined);
  }

  private onVisibilityChange = () => {
    if (document.hidden) {
      this.pauseAll();
    } else if (this.unlocked && !this.muted) {
      this.startLoops();
    }
  };

  private pauseAll() {
    this.wind.pause();
    this.score.pause();
    this.engine.pause();
    this.booster.pause();
    this.suitThruster.pause();
    for (const pool of Object.values(this.effects)) {
      for (const audio of pool) audio.pause();
    }
  }

  dispose() {
    this.disposed = true;
    this.pauseAll();
    window.removeEventListener("pointerdown", this.onFirstInteraction, { capture: true });
    window.removeEventListener("keydown", this.onFirstInteraction, { capture: true });
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}
