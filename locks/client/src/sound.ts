// Procedural sound for Locks. No audio files: every cue is synthesized with
// Tone.js, which suits the minimalist look, loads zero bytes, and stays
// tunable in code. Driven by the same GameEvent stream the renderer uses.
//
// Browser autoplay policy: audio can't start until a user gesture, so the
// AudioContext is resumed on first pointer/key via ensureAudio().

import * as Tone from 'tone';

let ready = false;
let master: Tone.Volume;

let shotSynth: Tone.MembraneSynth;
let crackNoise: Tone.NoiseSynth;
let hitSynth: Tone.MembraneSynth;
let deathSynth: Tone.Synth;
let grabSynth: Tone.Synth;
let captureSynth: Tone.PolySynth;
let uiSynth: Tone.Synth;

// Build the (small) synth graph once, lazily, after a user gesture.
export async function ensureAudio(): Promise<void> {
  if (ready) return;
  await Tone.start();

  master = new Tone.Volume(-6).toDestination();

  // Shot: a short low thump plus a filtered noise "crack" on top.
  shotSynth = new Tone.MembraneSynth({
    pitchDecay: 0.008,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.02 },
  }).connect(master);

  crackNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
  }).connect(new Tone.Filter(2200, 'highpass').connect(master));

  // Hit: a snappier, higher thump so kills read distinct from shots.
  hitSynth = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.05 },
  }).connect(master);

  // Your own death: a descending tone, more felt than the generic hit.
  deathSynth = new Tone.Synth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.1 },
  }).connect(new Tone.Filter(1200, 'lowpass').connect(master));

  grabSynth = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.15, sustain: 0 },
  }).connect(master);

  captureSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.2 },
  }).connect(master);

  uiSynth = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.005, decay: 0.08, sustain: 0 },
  }).connect(new Tone.Volume(-10).connect(master));

  ready = true;
}

// Distance-based gain so far-off shots are quieter than ones next to you.
// `d` is world-pixel distance; ~one screen width fades to near silence.
function proximityGain(d: number): number {
  const falloff = 900;
  return Math.max(0, 1 - d / falloff);
}

export function playShot(distance = 0) {
  if (!ready) return;
  const gain = proximityGain(distance);
  if (gain <= 0.02) return;
  const now = Tone.now();
  shotSynth.volume.value = Tone.gainToDb(gain);
  crackNoise.volume.value = Tone.gainToDb(gain * 0.6);
  shotSynth.triggerAttackRelease('C2', 0.12, now);
  crackNoise.triggerAttackRelease(0.03, now);
}

export function playKill(isSelf: boolean, distance = 0) {
  if (!ready) return;
  const now = Tone.now();
  if (isSelf) {
    deathSynth.triggerAttackRelease('A3', 0.4, now);
    deathSynth.frequency.rampTo('A2', 0.35, now);
  } else {
    const gain = proximityGain(distance);
    if (gain <= 0.02) return;
    hitSynth.volume.value = Tone.gainToDb(gain);
    hitSynth.triggerAttackRelease('G2', 0.18, now);
  }
}

export function playFlagGrab(isSelf: boolean) {
  if (!ready) return;
  grabSynth.triggerAttackRelease(isSelf ? 'E5' : 'C4', 0.15);
}

export function playCapture(scoredByYourTeam: boolean) {
  if (!ready) return;
  const now = Tone.now();
  const chord = scoredByYourTeam ? ['C4', 'E4', 'G4'] : ['C4', 'Eb4', 'G4'];
  captureSynth.triggerAttackRelease(chord, 0.4, now);
}

export function playRespawn() {
  if (!ready) return;
  uiSynth.triggerAttackRelease('C5', 0.08);
}

export function playUiClick() {
  if (!ready) return;
  uiSynth.triggerAttackRelease('A4', 0.05);
}
