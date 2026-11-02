import { MusicTrack } from '../data/tracks';

export class MuseSynthEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private mediaElement: HTMLAudioElement | null = null;
  private mediaSourceNode: MediaElementAudioSourceNode | null = null;
  private mediaGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private externalStreamMode = false;
  private freqData: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(64));
  private isPlaying = false;
  private isStreamActive = false;
  private isStreamLoading = false;
  private activeStreamUrl: string | null = null;
  private stepTimer: number | null = null;
  private currentTrack: MusicTrack | null = null;
  private volumeLevel = 0.85;
  private stepIndex = 0;
  private onEndedCallback: (() => void) | null = null;
  private triedDirectFallbackForUrl: string | null = null;
  private lastSeekTimeMs = 0;
  private virtualTimeSec = 0;
  private lastTickMs = 0;
  private streamRequestId = 0;

  public setOnEnded(cb: (() => void) | null) {
    this.onEndedCallback = cb;
  }

  public getActiveStreamUrl(): string | null {
    return this.activeStreamUrl;
  }

  private stopHarmonicSynth() {
    if (this.stepTimer !== null) {
      window.clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
  }

  /**
   * Synchronously unlocks Web Audio API AudioContext inside a user gesture.
   * Never sets a dummy src on mediaElement so it cannot collide with or abort startStreamPlayback.
   */
  public unlock() {
    this.ensureContext();
    this.ensureMediaElement();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
    }
  }

  private ensureContext() {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.82;
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.55;
      this.masterGain.connect(this.analyser);

      this.mediaGain = this.ctx.createGain();
      this.mediaGain.gain.value = 1.0;
      this.mediaGain.connect(this.analyser);

      this.outputGain = this.ctx.createGain();
      this.outputGain.gain.value = 1.0;
      this.analyser.connect(this.outputGain);
      this.outputGain.connect(this.ctx.destination);
      this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public setExternalStreamMode(enabled: boolean) {
    this.externalStreamMode = enabled;
    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.03);
    }
  }

  private toPlayableSourceUrl(rawUrl: string, useProxy: boolean): string {
    if (!rawUrl) return rawUrl;
    if (
      useProxy &&
      rawUrl.startsWith('http') &&
      !rawUrl.includes('/api/audio/proxy')
    ) {
      return `/api/audio/proxy?url=${encodeURIComponent(rawUrl)}`;
    }
    return rawUrl;
  }

  private ensureMediaElement() {
    this.ensureContext();
    if (!this.mediaElement && this.ctx && this.mediaGain) {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.loop = false;
      audio.preload = 'auto';
      audio.muted = false;
      audio.volume = Math.max(0.05, Math.min(1, this.volumeLevel));

      audio.addEventListener('playing', () => {
        this.isStreamActive = true;
        this.isStreamLoading = false;
        this.stopHarmonicSynth();
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      });

      audio.addEventListener('error', () => {
        if (!this.isPlaying || !this.activeStreamUrl || !audio.paused) return;
        const rawUrl = this.activeStreamUrl;
        const reqId = this.streamRequestId;
        if (this.triedDirectFallbackForUrl !== rawUrl && rawUrl.startsWith('http')) {
          this.triedDirectFallbackForUrl = rawUrl;
          audio.src = rawUrl;
          audio
            .play()
            .then(() => {
              if (reqId !== this.streamRequestId || !this.isPlaying) {
                audio.pause();
                return;
              }
              this.isStreamActive = true;
              this.isStreamLoading = false;
              this.stopHarmonicSynth();
            })
            .catch((err: any) => {
              if (reqId !== this.streamRequestId || !this.isPlaying || err?.name === 'AbortError') {
                return;
              }
              this.isStreamLoading = false;
              this.fallbackToHarmonicSynth();
            });
          return;
        }
        this.isStreamLoading = false;
        this.fallbackToHarmonicSynth();
      });

      audio.addEventListener('ended', () => {
        if (Date.now() - this.lastSeekTimeMs < 1800 || audio.seeking) {
          return;
        }

        const audioDur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        const fullTrackDur = Math.max(this.currentTrack?.duration || 0, audioDur);
        const currentPos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

        this.isStreamActive = false;
        this.isStreamLoading = false;

        const reachedFullEnd =
          currentPos >= Math.max(20, fullTrackDur - 3.5) ||
          (audioDur >= 50 && currentPos >= audioDur - 2.5);

        if (this.isPlaying && reachedFullEnd && this.onEndedCallback) {
          this.onEndedCallback();
          return;
        }

        if (this.isPlaying) {
          this.virtualTimeSec = currentPos;
          this.lastTickMs = performance.now();
        }
      });

      this.mediaElement = audio;
      try {
        this.mediaSourceNode = this.ctx.createMediaElementSource(audio);
        this.mediaSourceNode.connect(this.mediaGain);
      } catch {
        // Fallback if MediaElementSource already bound
      }
    }
  }

  public start(track: MusicTrack) {
    this.ensureContext();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
    }

    const isSameTrack = this.currentTrack?.id === track.id;
    const sameStreamUrl =
      Boolean(track.previewUrl) && this.activeStreamUrl === track.previewUrl;

    if (!isSameTrack) {
      this.virtualTimeSec = 0;
      this.lastTickMs = performance.now();
    }

    this.currentTrack = track;
    this.isPlaying = true;

    if (track.previewUrl) {
      this.stopHarmonicSynth();
      this.startStreamPlayback(track.previewUrl, !sameStreamUrl);
      return;
    }

    this.stopStreamOnly();
    this.stepIndex = 0;
    this.triggerBeatStep();
    this.reschedule();
  }

  private startStreamPlayback(streamUrl: string, reloadSource: boolean) {
    this.ensureMediaElement();
    if (!this.mediaElement) return;

    this.stopHarmonicSynth();

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const effectiveVolume = Math.max(0, Math.min(1, this.volumeLevel));
    this.mediaElement.muted = effectiveVolume === 0;
    this.mediaElement.volume = effectiveVolume;
    this.mediaElement.playbackRate = 1.0;

    // If this exact stream URL is already playing or currently loading, never reload or call play() a second time
    if (
      !reloadSource &&
      this.activeStreamUrl === streamUrl &&
      (this.isStreamActive || this.isStreamLoading || !this.mediaElement.paused)
    ) {
      if (this.mediaElement.paused && !this.isStreamLoading) {
        this.mediaElement.play().catch(() => {});
      }
      return;
    }

    const reqId = ++this.streamRequestId;
    const primarySrc = this.toPlayableSourceUrl(streamUrl, true);

    if (reloadSource || this.activeStreamUrl !== streamUrl || !this.mediaElement.src) {
      try {
        this.mediaElement.pause();
      } catch {
        // Ignore pause error
      }
      this.triedDirectFallbackForUrl = null;
      this.activeStreamUrl = streamUrl;
      this.isStreamActive = false;
      this.isStreamLoading = true;
      this.mediaElement.src = primarySrc;
    } else {
      this.isStreamLoading = true;
    }

    this.mediaElement
      .play()
      .then(() => {
        if (reqId !== this.streamRequestId || !this.isPlaying) {
          this.mediaElement?.pause();
          return;
        }
        this.isStreamActive = true;
        this.isStreamLoading = false;
        this.stopHarmonicSynth();
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      })
      .catch((err: any) => {
        // Ignore AbortError from rapid track switches or duplicate calls so we never restart or trigger synth over a stream
        if (reqId !== this.streamRequestId || !this.isPlaying || err?.name === 'AbortError') {
          return;
        }
        // Retry once with direct CDN URL if proxy failed
        if (
          streamUrl.startsWith('http') &&
          this.triedDirectFallbackForUrl !== streamUrl &&
          this.mediaElement
        ) {
          this.triedDirectFallbackForUrl = streamUrl;
          this.activeStreamUrl = streamUrl;
          this.mediaElement.src = streamUrl;
          this.mediaElement
            .play()
            .then(() => {
              if (reqId !== this.streamRequestId || !this.isPlaying) {
                this.mediaElement?.pause();
                return;
              }
              this.isStreamActive = true;
              this.isStreamLoading = false;
              this.stopHarmonicSynth();
            })
            .catch((retryErr: any) => {
              if (
                reqId !== this.streamRequestId ||
                !this.isPlaying ||
                retryErr?.name === 'AbortError'
              ) {
                return;
              }
              this.isStreamLoading = false;
              this.fallbackToHarmonicSynth();
            });
          return;
        }
        this.isStreamLoading = false;
        this.fallbackToHarmonicSynth();
      });
  }

  private fallbackToHarmonicSynth() {
    if (
      !this.isPlaying ||
      this.isStreamActive ||
      this.isStreamLoading ||
      (this.mediaElement && !this.mediaElement.paused)
    ) {
      return;
    }
    this.isStreamActive = false;
    this.isStreamLoading = false;
    this.lastTickMs = performance.now();
    if (this.stepTimer === null) {
      this.stepIndex = 0;
      this.triggerBeatStep();
      this.reschedule();
    }
  }

  private stopStreamOnly() {
    this.streamRequestId++;
    this.isStreamActive = false;
    this.isStreamLoading = false;
    if (this.mediaElement) {
      try {
        this.mediaElement.pause();
      } catch {
        // Ignore pause error
      }
    }
  }

  public updateTrack(track: MusicTrack, _tempoMultiplier = 1.0) {
    this.currentTrack = track;

    if (this.mediaElement && this.isStreamActive) {
      this.mediaElement.playbackRate = 1.0;
    }

    // Never interrupt or reload an already-playing audio stream mid-song
    if (this.isPlaying && (this.isStreamActive || this.isStreamLoading)) {
      return;
    }

    if (this.isPlaying) {
      if (track.previewUrl) {
        this.startStreamPlayback(track.previewUrl, true);
      } else {
        this.reschedule();
      }
    }
  }

  public seek(seconds: number) {
    const targetSec = Math.max(0, seconds);
    this.lastSeekTimeMs = Date.now();
    this.virtualTimeSec = targetSec;
    this.lastTickMs = performance.now();

    if (this.mediaElement && (this.isStreamActive || this.isStreamLoading)) {
      const mediaDur = this.mediaElement.duration;
      if (Number.isFinite(mediaDur) && mediaDur > 0) {
        if (targetSec < mediaDur - 1.2) {
          try {
            this.mediaElement.currentTime = targetSec;
            if (this.isPlaying && this.mediaElement.paused && !this.isStreamLoading) {
              this.mediaElement.play().catch(() => {});
            }
          } catch {
            // Ignore transient seek error
          }
          return;
        } else {
          this.stopStreamOnly();
          this.fallbackToHarmonicSynth();
          return;
        }
      }
    }
  }

  public getCurrentTime(): number | null {
    if (this.mediaElement && (this.isStreamActive || this.isStreamLoading)) {
      const ct = this.mediaElement.currentTime;
      if (Number.isFinite(ct) && ct >= 0) {
        this.virtualTimeSec = ct;
        this.lastTickMs = performance.now();
        return ct;
      }
      return this.virtualTimeSec;
    }
    if (this.isPlaying) {
      const now = performance.now();
      if (this.lastTickMs > 0) {
        const dt = Math.max(0, Math.min(1, (now - this.lastTickMs) / 1000));
        this.virtualTimeSec += dt;
      }
      this.lastTickMs = now;
      return this.virtualTimeSec;
    }
    return null;
  }

  public getStreamDuration(): number | null {
    if (this.mediaElement && (this.isStreamActive || this.isStreamLoading)) {
      const dur = this.mediaElement.duration;
      if (Number.isFinite(dur) && dur >= 45) {
        return Math.round(dur);
      }
    }
    return null;
  }

  public setVolume(val: number) {
    this.volumeLevel = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        Math.max(0, Math.min(0.75, this.volumeLevel * 0.65)),
        this.ctx.currentTime,
        0.03
      );
    }
    if (this.mediaGain && this.ctx) {
      this.mediaGain.gain.setTargetAtTime(
        Math.max(0, Math.min(1.0, this.volumeLevel)),
        this.ctx.currentTime,
        0.03
      );
    }
    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.03);
    }
    if (this.mediaElement) {
      this.mediaElement.muted = this.volumeLevel === 0;
      this.mediaElement.volume = this.volumeLevel;
    }
  }

  public stop() {
    this.isPlaying = false;
    this.stopStreamOnly();
    this.stopHarmonicSynth();
  }

  public isStreamingRealAudio(): boolean {
    return this.isPlaying && (this.isStreamActive || this.isStreamLoading);
  }

  private reschedule() {
    this.stopHarmonicSynth();
    if (
      !this.isPlaying ||
      !this.currentTrack ||
      this.isStreamActive ||
      this.isStreamLoading ||
      (this.mediaElement && !this.mediaElement.paused)
    ) {
      return;
    }
    const effectiveBpm = Math.max(60, Math.min(200, this.currentTrack.bpm));
    const beatMs = (60 / effectiveBpm) * 1000;
    this.stepTimer = window.setInterval(() => {
      this.triggerBeatStep();
    }, beatMs);
  }

  private rollingBassAvg = 0.12;
  private beatPulse = 0;
  private lastBeatTime = 0;
  private lastMetricsTime = performance.now();

  private triggerBeatStep() {
    if (
      !this.ctx ||
      !this.masterGain ||
      !this.currentTrack ||
      !this.isPlaying ||
      this.isStreamActive ||
      this.isStreamLoading ||
      (this.mediaElement && !this.mediaElement.paused)
    ) {
      this.stopHarmonicSynth();
      return;
    }
    const now = this.ctx.currentTime;
    const chords = this.currentTrack.chordProgression;
    const chord = chords[Math.floor(this.stepIndex / 4) % chords.length];
    const subBeat = this.stepIndex % 4;

    // 1. Sub-bass pulse on beats 0 and 2
    if (subBeat === 0 || subBeat === 2) {
      this.beatPulse = Math.max(this.beatPulse, subBeat === 0 ? 0.95 : 0.72);
      this.lastBeatTime = performance.now();

      const kickOsc = this.ctx.createOscillator();
      const kickGain = this.ctx.createGain();
      kickOsc.type = 'sine';
      kickOsc.frequency.setValueAtTime(115, now);
      kickOsc.frequency.exponentialRampToValueAtTime(42, now + 0.18);

      kickGain.gain.setValueAtTime(0.55, now);
      kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

      kickOsc.connect(kickGain);
      kickGain.connect(this.masterGain);
      kickOsc.start(now);
      kickOsc.stop(now + 0.34);
    } else {
      this.beatPulse = Math.max(this.beatPulse, 0.35);
    }

    // 2. Warm ambient pad chord on beat 0
    if (subBeat === 0) {
      chord.forEach((freq, idx) => {
        if (!this.ctx || !this.masterGain) return;
        const padOsc = this.ctx.createOscillator();
        const padFilter = this.ctx.createBiquadFilter();
        const padGain = this.ctx.createGain();

        padOsc.type = idx % 2 === 0 ? 'triangle' : 'sine';
        padOsc.frequency.setValueAtTime(freq, now);

        padFilter.type = 'lowpass';
        padFilter.frequency.setValueAtTime(900 + idx * 250, now);

        padGain.gain.setValueAtTime(0.001, now);
        padGain.gain.linearRampToValueAtTime(0.11, now + 0.4);
        padGain.gain.exponentialRampToValueAtTime(0.001, now + 2.2);

        padOsc.connect(padFilter);
        padFilter.connect(padGain);
        padGain.connect(this.masterGain);

        padOsc.start(now);
        padOsc.stop(now + 2.3);
      });
    }

    // 3. Delicate harmonic arpeggio note on every beat
    const arpNote = chord[subBeat % chord.length] * 2;
    const arpOsc = this.ctx.createOscillator();
    const arpGain = this.ctx.createGain();
    arpOsc.type = 'sine';
    arpOsc.frequency.setValueAtTime(arpNote, now);

    arpGain.gain.setValueAtTime(0.001, now);
    arpGain.gain.linearRampToValueAtTime(0.08, now + 0.03);
    arpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    arpOsc.connect(arpGain);
    arpGain.connect(this.masterGain);
    arpOsc.start(now);
    arpOsc.stop(now + 0.48);

    this.stepIndex++;
  }

  public getFrequencyData(): Uint8Array {
    if (!this.analyser) return new Uint8Array(64);
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  public getAudioMetrics(): {
    bass: number;
    mid: number;
    high: number;
    energy: number;
    transient: number;
    isBeat: boolean;
    beatTimestamp: number;
  } {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastMetricsTime) / 1000));
    this.lastMetricsTime = now;

    // Exponential decay on beat pulse envelope
    this.beatPulse = Math.max(0, this.beatPulse * Math.exp(-6.8 * dt));

    if (!this.analyser || !this.isPlaying) {
      this.rollingBassAvg = 0.08;
      return {
        bass: 0.08,
        mid: 0.06,
        high: 0.04,
        energy: 0.06,
        transient: 0,
        isBeat: false,
        beatTimestamp: this.lastBeatTime,
      };
    }

    this.analyser.getByteFrequencyData(this.freqData);
    let subBassSum = 0;
    let bassSum = 0;
    let midSum = 0;
    let highSum = 0;
    const len = this.freqData.length;

    for (let i = 0; i < len; i++) {
      const v = this.freqData[i] / 255;
      if (i < 5) subBassSum += v;
      if (i < 8) bassSum += v;
      else if (i < 24) midSum += v;
      else highSum += v;
    }

    const subBass = subBassSum / 5;
    const bass = bassSum / 8;
    const mid = midSum / 16;
    const high = highSum / Math.max(1, len - 24);
    const energy = bass * 0.5 + mid * 0.35 + high * 0.15;

    // Detect transient onsets (beat peaks) from low-frequency flux above rolling average
    const flux = Math.max(0, subBass - this.rollingBassAvg);
    this.rollingBassAvg = this.rollingBassAvg * 0.92 + subBass * 0.08;

    if (flux > 0.048 && subBass > 0.16 && now - this.lastBeatTime > 175) {
      this.lastBeatTime = now;
      const peakIntensity = Math.min(1.0, 0.58 + flux * 3.4);
      this.beatPulse = Math.max(this.beatPulse, peakIntensity);
    }

    const isBeat = now - this.lastBeatTime < 28 && this.beatPulse > 0.45;
    const transient = Math.min(1.0, this.beatPulse);
    return { bass, mid, high, energy, transient, isBeat, beatTimestamp: this.lastBeatTime };
  }
}

export const synthEngine = new MuseSynthEngine();

if (typeof window !== 'undefined') {
  const autoUnlock = () => {
    synthEngine.unlock();
  };
  window.addEventListener('pointerdown', autoUnlock, { passive: true });
  window.addEventListener('keydown', autoUnlock, { passive: true });
}

