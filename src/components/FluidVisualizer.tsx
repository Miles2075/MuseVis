import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TrackPalette } from '../data/tracks';
import { synthEngine } from '../utils/audioEngine';

interface FluidVisualizerProps {
  palette: TrackPalette;
  bpm: number;
  tempoMultiplier: number;
  bloomIntensity: number;
  isPlaying: boolean;
  cameraPreset: 'center' | 'orbital' | 'macro';
}

// Pre-allocated math helpers at module scope (zero GC in render loop)
const _targetPrimary = new THREE.Color();
const _targetSecondary = new THREE.Color();
const _targetAccent = new THREE.Color();
const _camTargetPos = new THREE.Vector3();
const _lookAtTarget = new THREE.Vector3(0, 0.05, 0);

export function FluidVisualizer({
  palette,
  bpm,
  tempoMultiplier,
  bloomIntensity,
  isPlaying,
  cameraPreset,
}: FluidVisualizerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({
    palette,
    bpm,
    tempoMultiplier,
    bloomIntensity,
    isPlaying,
    cameraPreset,
  });

  useEffect(() => {
    stateRef.current = { palette, bpm, tempoMultiplier, bloomIntensity, isPlaying, cameraPreset };
  }, [palette, bpm, tempoMultiplier, bloomIntensity, isPlaying, cameraPreset]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // 1. Software WebGL detection per Three.js skill guidelines
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      44,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    camera.position.set(0, 0.35, 6.2);

    const waveGroup = new THREE.Group();
    scene.add(waveGroup);

    // Interactive mouse parallax state
    const pointerTarget = { x: 0, y: 0 };
    const pointerCurrent = { x: 0, y: 0 };
    const handlePointerMove = (e: MouseEvent) => {
      pointerTarget.x = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      pointerTarget.y = -(e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
    };
    window.addEventListener('mousemove', handlePointerMove, { passive: true });

    // Part 1: Iridescent Flowing Aurora Silk Veil (Smooth organic folds, zero grid lines)
    const segX = isSoftwareGl ? 76 : 168;
    const segY = isSoftwareGl ? 28 : 56;
    const silkGeo = new THREE.PlaneGeometry(17.5, 5.2, segX, segY);

    const silkUniforms = {
      uTime: { value: 0 },
      uBass: { value: 0.1 },
      uMid: { value: 0.08 },
      uEnergy: { value: 0.12 },
      uTransient: { value: 0.0 },
      uOpacityScale: { value: 1.0 },
      uColorPrimary: { value: new THREE.Color(stateRef.current.palette.primary) },
      uColorSecondary: { value: new THREE.Color(stateRef.current.palette.secondary) },
      uColorAccent: { value: new THREE.Color(stateRef.current.palette.accent) },
    };

    const silkVertexShader = `
      uniform float uTime;
      uniform float uBass;
      uniform float uMid;
      uniform float uEnergy;
      uniform float uTransient;
      varying vec2 vUv;
      varying float vElevation;
      varying float vCrest;

      void main() {
        vUv = uv;
        vec3 pos = position;

        // Multi-harmonic organic fluid waves across X and Y
        float w1 = sin(pos.x * 0.46 + uTime * 0.68) * cos(pos.y * 0.75 - uTime * 0.44);
        float w2 = sin(pos.x * 0.88 - uTime * 0.52 + pos.y * 0.9) * 0.58;
        float w3 = cos(pos.x * 1.45 + pos.y * 1.2 + uTime * 0.82) * (0.24 + uMid * 0.35);

        float amp = 0.42 + uEnergy * 0.55 + uBass * 0.48 + uTransient * 0.42;
        float elevation = (w1 + w2 + w3) * amp;

        pos.z += elevation;
        pos.y += sin(pos.x * 0.34 + uTime * 0.36) * (0.22 + uBass * 0.18);

        vElevation = elevation;
        vCrest = smoothstep(-0.3, 0.95, w1 + w2 * 0.8 + uTransient * 0.45);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `;

    const silkFragmentShader = `
      uniform vec3 uColorPrimary;
      uniform vec3 uColorSecondary;
      uniform vec3 uColorAccent;
      uniform float uTransient;
      uniform float uBass;
      uniform float uOpacityScale;
      varying vec2 vUv;
      varying float vElevation;
      varying float vCrest;

      void main() {
        // Feathered elliptical bounds for seamless atmospheric blending
        float edgeX = smoothstep(0.0, 0.24, vUv.x) * smoothstep(1.0, 0.76, vUv.x);
        float edgeY = smoothstep(0.0, 0.28, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
        float mask = edgeX * edgeY;

        // Smooth iridescent silk fold sheen without harsh stripes
        float fold = smoothstep(-0.85, 0.95, vElevation);
        float ribbonCore = exp(-pow((vUv.y - 0.5) * 3.1, 2.0));
        float causticGlow = pow(vCrest, 2.6) * ribbonCore;

        vec3 baseCol = mix(uColorSecondary, uColorPrimary, fold);
        vec3 finalCol = mix(baseCol, uColorAccent, causticGlow * 0.78 + uTransient * 0.32);

        float alpha = mask * (0.14 + fold * 0.18 + causticGlow * 0.24 + uBass * 0.08 + uTransient * 0.12) * uOpacityScale;
        gl_FragColor = vec4(finalCol, alpha);
      }
    `;

    const silkMat = new THREE.ShaderMaterial({
      uniforms: silkUniforms,
      vertexShader: silkVertexShader,
      fragmentShader: silkFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const silkMesh = new THREE.Mesh(silkGeo, silkMat);
    silkMesh.position.set(0, -0.22, -1.25);
    silkMesh.rotation.x = -0.52;
    waveGroup.add(silkMesh);

    // Part 2: Counter-Flowing Upper Aurora Ribbon
    const backSilkGeo = new THREE.PlaneGeometry(
      18.5,
      4.4,
      Math.round(segX * 0.75),
      Math.round(segY * 0.75)
    );
    const backSilkUniforms = {
      uTime: { value: 12 },
      uBass: { value: 0.1 },
      uMid: { value: 0.08 },
      uEnergy: { value: 0.12 },
      uTransient: { value: 0.0 },
      uOpacityScale: { value: 0.72 },
      uColorPrimary: { value: new THREE.Color(stateRef.current.palette.secondary) },
      uColorSecondary: { value: new THREE.Color(stateRef.current.palette.primary) },
      uColorAccent: { value: new THREE.Color(stateRef.current.palette.accent) },
    };

    const backSilkMat = new THREE.ShaderMaterial({
      uniforms: backSilkUniforms,
      vertexShader: silkVertexShader,
      fragmentShader: silkFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const backSilkMesh = new THREE.Mesh(backSilkGeo, backSilkMat);
    backSilkMesh.position.set(0, 0.42, -2.55);
    backSilkMesh.rotation.x = -0.28;
    backSilkMesh.rotation.z = 0.08;
    waveGroup.add(backSilkMesh);

    // Part 3: Sculptural Harmonic Resonance Halo Ring (Frames the center-stage lyrics)
    const haloGeo = new THREE.PlaneGeometry(7.2, 7.2, 1, 1);
    const haloUniforms = {
      uTime: { value: 0 },
      uBass: { value: 0.1 },
      uMid: { value: 0.08 },
      uTransient: { value: 0.0 },
      uColorPrimary: { value: new THREE.Color(stateRef.current.palette.primary) },
      uColorSecondary: { value: new THREE.Color(stateRef.current.palette.secondary) },
      uColorAccent: { value: new THREE.Color(stateRef.current.palette.accent) },
    };

    const haloMat = new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uBass;
        uniform float uMid;
        uniform float uTransient;
        uniform vec3 uColorPrimary;
        uniform vec3 uColorSecondary;
        uniform vec3 uColorAccent;
        varying vec2 vUv;

        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          if (r > 1.0) discard;

          float angle = atan(p.y, p.x);
          // Organic acoustic harmonic modulation around the ring
          float harmonic = sin(angle * 3.0 + uTime * 0.9) * 0.028
                         + cos(angle * 5.0 - uTime * 1.3) * (0.018 + uMid * 0.035)
                         + sin(angle * 8.0 + uTime * 2.1) * (uTransient * 0.025);

          float targetRadius = 0.48 + uBass * 0.06 + uTransient * 0.045 + harmonic;
          float distToRing = abs(r - targetRadius);

          // Primary luminous eclipse ring + outer beat ripple
          float ringGlow = exp(-distToRing * (22.0 - uTransient * 6.0));
          float outerRippleRadius = fract(uTime * 0.28) * 0.48 + 0.46;
          float outerRipple = exp(-abs(r - outerRippleRadius) * 34.0) * (1.0 - fract(uTime * 0.28)) * (0.45 + uTransient * 0.8);

          // Soft inner nebula core
          float innerMist = smoothstep(0.65, 0.0, r) * (0.08 + uBass * 0.09);

          float gradMix = 0.5 + 0.5 * sin(angle * 2.0 + uTime * 0.6);
          vec3 ringCol = mix(uColorPrimary, uColorSecondary, gradMix);
          ringCol = mix(ringCol, uColorAccent, ringGlow * 0.55 + uTransient * 0.35);

          float alpha = ringGlow * (0.28 + uTransient * 0.24 + uBass * 0.15)
                      + outerRipple * 0.22
                      + innerMist;

          gl_FragColor = vec4(ringCol, alpha * smoothstep(1.0, 0.78, r));
        }
      `,
    });

    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    haloMesh.position.set(0, 0.12, -1.9);
    waveGroup.add(haloMesh);

    // Part 4: Luminous Floating Bokeh & Stardust Field
    const particleCount = isSoftwareGl ? 55 : 110;
    const particlePositions = new Float32Array(particleCount * 3);
    const particleScales = new Float32Array(particleCount);
    const particlePhases = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      particlePositions[i * 3] = (Math.random() - 0.5) * 13.5;
      particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 6.2;
      particlePositions[i * 3 + 2] = -0.3 - Math.random() * 4.2;
      particleScales[i] = 0.45 + Math.random() * 1.35;
      particlePhases[i] = Math.random() * Math.PI * 2;
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeo.setAttribute('aScale', new THREE.BufferAttribute(particleScales, 1));
    particleGeo.setAttribute('aPhase', new THREE.BufferAttribute(particlePhases, 1));

    const particleUniforms = {
      uTime: { value: 0 },
      uBass: { value: 0.1 },
      uTransient: { value: 0 },
      uColorAccent: { value: new THREE.Color(stateRef.current.palette.accent) },
      uColorPrimary: { value: new THREE.Color(stateRef.current.palette.primary) },
    };

    const particleMat = new THREE.ShaderMaterial({
      uniforms: particleUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aScale;
        attribute float aPhase;
        uniform float uTime;
        uniform float uBass;
        uniform float uTransient;
        varying float vAlpha;
        varying float vMix;

        void main() {
          vec3 pos = position;
          pos.y += sin(uTime * 0.42 + pos.x * 0.65 + aPhase) * (0.18 + uBass * 0.12);
          pos.x += cos(uTime * 0.32 + pos.z * 0.7 + aPhase) * 0.14;

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aScale * (18.0 + uTransient * 11.0 + uBass * 6.0) * (1.0 / -mvPosition.z);
          vAlpha = 0.12 + 0.22 * (0.5 + 0.5 * sin(uTime * 1.1 + aPhase)) + uTransient * 0.16;
          vMix = 0.5 + 0.5 * cos(aPhase + uTime * 0.5);
        }
      `,
      fragmentShader: `
        uniform vec3 uColorAccent;
        uniform vec3 uColorPrimary;
        varying float vAlpha;
        varying float vMix;

        void main() {
          float dist = length(gl_PointCoord - vec2(0.5));
          if (dist > 0.5) discard;
          float soft = pow(1.0 - dist * 2.0, 2.0);
          vec3 col = mix(uColorPrimary, uColorAccent, vMix * 0.6 + soft * 0.4);
          gl_FragColor = vec4(col, soft * vAlpha);
        }
      `,
    });

    const particleSystem = new THREE.Points(particleGeo, particleMat);
    scene.add(particleSystem);

    // Part 5: Transient Peak (Beat) Particle Burst System (Colored by Track Accent Palette)
    const burstCount = isSoftwareGl ? 100 : 200;
    const burstEmitPerBeat = isSoftwareGl ? 20 : 36;
    const burstPositions = new Float32Array(burstCount * 3);
    const burstVelocities = new Float32Array(burstCount * 3);
    const burstScales = new Float32Array(burstCount);
    const burstLives = new Float32Array(burstCount); // 1.0 -> 0.0
    const burstDurations = new Float32Array(burstCount);
    let burstCursor = 0;

    for (let i = 0; i < burstCount; i++) {
      burstPositions[i * 3 + 2] = -50; // Hide inactive particles far behind camera
      burstLives[i] = 0;
      burstDurations[i] = 0.85;
      burstScales[i] = 1.0;
    }

    const burstGeo = new THREE.BufferGeometry();
    const burstPosAttr = new THREE.BufferAttribute(burstPositions, 3);
    burstPosAttr.setUsage(THREE.DynamicDrawUsage);
    const burstScaleAttr = new THREE.BufferAttribute(burstScales, 1);
    burstScaleAttr.setUsage(THREE.DynamicDrawUsage);
    const burstLifeAttr = new THREE.BufferAttribute(burstLives, 1);
    burstLifeAttr.setUsage(THREE.DynamicDrawUsage);

    burstGeo.setAttribute('position', burstPosAttr);
    burstGeo.setAttribute('aScale', burstScaleAttr);
    burstGeo.setAttribute('aLife', burstLifeAttr);

    const burstUniforms = {
      uColorAccent: { value: new THREE.Color(stateRef.current.palette.accent) },
    };

    const burstMat = new THREE.ShaderMaterial({
      uniforms: burstUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aScale;
        attribute float aLife;
        varying float vLife;

        void main() {
          vLife = aLife;
          if (aLife <= 0.001) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            return;
          }
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          // Pop in size on initial burst, then taper as life decays
          float sizeEnvelope = sin(clamp(aLife, 0.0, 1.0) * 3.14159265);
          gl_PointSize = aScale * (26.0 * (0.35 + 0.65 * sizeEnvelope)) * (1.0 / max(0.5, -mvPosition.z));
        }
      `,
      fragmentShader: `
        uniform vec3 uColorAccent;
        varying float vLife;

        void main() {
          if (vLife <= 0.001) discard;
          float dist = length(gl_PointCoord - vec2(0.5));
          if (dist > 0.5) discard;

          float radialGlow = pow(1.0 - dist * 2.0, 2.2);
          float hotCore = smoothstep(0.24, 0.0, dist);
          // Match current track's accent palette with a luminous incandescent center
          vec3 burstCol = mix(uColorAccent, vec3(1.0, 0.99, 0.96), hotCore * 0.62);
          float alpha = radialGlow * smoothstep(0.0, 0.25, vLife) * (0.45 + 0.55 * vLife);
          gl_FragColor = vec4(burstCol, alpha);
        }
      `,
    });

    const burstSystem = new THREE.Points(burstGeo, burstMat);
    waveGroup.add(burstSystem);

    const emitBeatBurst = (intensity: number) => {
      const count = Math.round(burstEmitPerBeat * (0.7 + intensity * 0.5));
      for (let k = 0; k < count; k++) {
        const idx = burstCursor;
        burstCursor = (burstCursor + 1) % burstCount;

        const angle = (k / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.45;
        const ringRadius = 1.45 + (Math.random() - 0.5) * 0.55;
        const spawnX = Math.cos(angle) * ringRadius;
        const spawnY = Math.sin(angle) * ringRadius * 0.82 + 0.1;
        const spawnZ = -1.65 + (Math.random() - 0.5) * 0.45;

        burstPositions[idx * 3] = spawnX;
        burstPositions[idx * 3 + 1] = spawnY;
        burstPositions[idx * 3 + 2] = spawnZ;

        const radialSpeed = (1.35 + Math.random() * 2.25) * (0.65 + intensity * 0.75);
        burstVelocities[idx * 3] = Math.cos(angle) * radialSpeed + (Math.random() - 0.5) * 0.5;
        burstVelocities[idx * 3 + 1] =
          Math.sin(angle) * radialSpeed * 0.85 + 0.35 + Math.random() * 0.65;
        burstVelocities[idx * 3 + 2] = (Math.random() - 0.35) * 1.4;

        burstScales[idx] = 0.65 + Math.random() * 1.25 + intensity * 0.75;
        burstLives[idx] = 1.0;
        burstDurations[idx] = 0.62 + Math.random() * 0.55;
      }
      burstPosAttr.needsUpdate = true;
      burstScaleAttr.needsUpdate = true;
      burstLifeAttr.needsUpdate = true;
    };

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Animation Loop
    let frameId = 0;
    let isDisposed = false;
    const clock = new THREE.Clock();
    let accumulatedTime = 0;
    let smoothedBass = 0.08;
    let smoothedMid = 0.06;
    let smoothedEnergy = 0.1;
    let smoothedTransient = 0.0;
    let lastHandledBeatTimestamp = 0;
    let prevRawTransient = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (isDisposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (isDisposed) return;
      const delta = Math.min(clock.getDelta(), 0.1);
      const {
        palette: pal,
        bpm: curBpm,
        tempoMultiplier: mult,
        isPlaying: playing,
        cameraPreset: preset,
      } = stateRef.current;

      const metrics = synthEngine.getAudioMetrics();
      const targetBass = playing ? Math.max(0.14, metrics.bass) : 0.06;
      const targetMid = playing ? Math.max(0.1, metrics.mid) : 0.04;
      const targetEnergy = playing ? Math.max(0.16, metrics.energy) : 0.07;
      const targetTransient = playing ? metrics.transient : 0.0;

      // Detect transient peak events (beats) from synthEngine analyzer and trigger accent particle burst
      const risingEdgeSpike =
        playing && metrics.transient - prevRawTransient > 0.18 && metrics.transient > 0.45;
      const newBeatDetected =
        playing &&
        metrics.isBeat &&
        metrics.beatTimestamp > 0 &&
        metrics.beatTimestamp !== lastHandledBeatTimestamp;

      if (newBeatDetected || risingEdgeSpike) {
        lastHandledBeatTimestamp = metrics.beatTimestamp;
        emitBeatBurst(Math.max(0.55, metrics.transient));
      }
      prevRawTransient = metrics.transient;

      // Update active burst particles physics & decay
      let hasActiveBurst = false;
      const drag = Math.exp(-2.6 * delta);
      for (let i = 0; i < burstCount; i++) {
        const life = burstLives[i];
        if (life > 0) {
          hasActiveBurst = true;
          const i3 = i * 3;
          burstPositions[i3] += burstVelocities[i3] * delta;
          burstPositions[i3 + 1] += burstVelocities[i3 + 1] * delta;
          burstPositions[i3 + 2] += burstVelocities[i3 + 2] * delta;

          burstVelocities[i3] *= drag;
          burstVelocities[i3 + 1] = burstVelocities[i3 + 1] * drag + 0.18 * delta;
          burstVelocities[i3 + 2] *= drag;

          const nextLife = life - delta / Math.max(0.25, burstDurations[i]);
          if (nextLife <= 0) {
            burstLives[i] = 0;
            burstPositions[i3 + 2] = -50;
          } else {
            burstLives[i] = nextLife;
          }
        }
      }
      if (hasActiveBurst) {
        burstPosAttr.needsUpdate = true;
        burstLifeAttr.needsUpdate = true;
      }

      smoothedBass = THREE.MathUtils.damp(smoothedBass, targetBass, 6.5, delta);
      smoothedMid = THREE.MathUtils.damp(smoothedMid, targetMid, 6.0, delta);
      smoothedEnergy = THREE.MathUtils.damp(smoothedEnergy, targetEnergy, 5.5, delta);
      smoothedTransient = THREE.MathUtils.damp(
        smoothedTransient,
        targetTransient,
        targetTransient > smoothedTransient ? 16 : 6.5,
        delta
      );

      const effectiveBpm = curBpm * mult;
      const speedFactor =
        (effectiveBpm / 100) * (playing ? 0.72 + smoothedTransient * 0.35 : 0.22);
      accumulatedTime += delta * speedFactor;

      // Smoothly damp colors toward current track palette
      _targetPrimary.set(pal.primary);
      _targetSecondary.set(pal.secondary);
      _targetAccent.set(pal.accent);

      const colorLerp = 1 - Math.exp(-3.8 * delta);
      silkUniforms.uTime.value = accumulatedTime;
      silkUniforms.uBass.value = smoothedBass;
      silkUniforms.uMid.value = smoothedMid;
      silkUniforms.uEnergy.value = smoothedEnergy;
      silkUniforms.uTransient.value = smoothedTransient;
      // Injecting Bloom Intensity as a multiplier into existing shader alpha/glows
      const bloom = stateRef.current.bloomIntensity;
      silkUniforms.uOpacityScale.value = bloom;
      
      silkUniforms.uColorPrimary.value.lerp(_targetPrimary, colorLerp);
      silkUniforms.uColorSecondary.value.lerp(_targetSecondary, colorLerp);
      silkUniforms.uColorAccent.value.lerp(_targetAccent, colorLerp);

      backSilkUniforms.uTime.value = -accumulatedTime * 0.82 + 12.0;
      backSilkUniforms.uBass.value = smoothedBass;
      backSilkUniforms.uMid.value = smoothedMid;
      backSilkUniforms.uEnergy.value = smoothedEnergy;
      backSilkUniforms.uTransient.value = smoothedTransient;
      backSilkUniforms.uColorPrimary.value.copy(silkUniforms.uColorSecondary.value);
      backSilkUniforms.uColorSecondary.value.copy(silkUniforms.uColorPrimary.value);
      backSilkUniforms.uColorAccent.value.copy(silkUniforms.uColorAccent.value);

      haloUniforms.uTime.value = accumulatedTime;
      haloUniforms.uBass.value = smoothedBass;
      haloUniforms.uMid.value = smoothedMid;
      haloUniforms.uTransient.value = smoothedTransient;
      haloUniforms.uColorPrimary.value.copy(silkUniforms.uColorPrimary.value);
      haloUniforms.uColorSecondary.value.copy(silkUniforms.uColorSecondary.value);
      haloUniforms.uColorAccent.value.copy(silkUniforms.uColorAccent.value);

      particleUniforms.uTime.value = accumulatedTime;
      particleUniforms.uBass.value = smoothedBass;
      particleUniforms.uTransient.value = smoothedTransient;
      particleUniforms.uColorPrimary.value.copy(silkUniforms.uColorPrimary.value);
      particleUniforms.uColorAccent.value.copy(silkUniforms.uColorAccent.value);

      // Sync burst particle shader accent color with current track's interpolated accent palette
      burstUniforms.uColorAccent.value.copy(silkUniforms.uColorAccent.value);

      // Smooth cursor parallax + beat breathing
      pointerCurrent.x = THREE.MathUtils.damp(pointerCurrent.x, pointerTarget.x, 4.0, delta);
      pointerCurrent.y = THREE.MathUtils.damp(pointerCurrent.y, pointerTarget.y, 4.0, delta);

      const pulseScale = 1 + smoothedTransient * 0.045 + smoothedBass * 0.02;
      waveGroup.scale.set(pulseScale, pulseScale, 1);
      waveGroup.rotation.y = pointerCurrent.x * 0.14;
      waveGroup.rotation.x = pointerCurrent.y * 0.08;

      // Subtle camera drift based on preset
      if (preset === 'center') {
        _camTargetPos.set(
          Math.sin(accumulatedTime * 0.18) * 0.35 + pointerCurrent.x * 0.25,
          0.32 + Math.cos(accumulatedTime * 0.14) * 0.14 + pointerCurrent.y * 0.18,
          6.1
        );
      } else if (preset === 'orbital') {
        _camTargetPos.set(
          Math.sin(accumulatedTime * 0.26) * 2.3 + pointerCurrent.x * 0.35,
          0.6 + Math.sin(accumulatedTime * 0.18) * 0.28,
          5.5
        );
      } else {
        _camTargetPos.set(
          Math.sin(accumulatedTime * 0.22) * 0.65 + pointerCurrent.x * 0.2,
          0.16 + pointerCurrent.y * 0.15,
          4.35
        );
      }

      camera.position.x = THREE.MathUtils.damp(camera.position.x, _camTargetPos.x, 3.2, delta);
      camera.position.y = THREE.MathUtils.damp(camera.position.y, _camTargetPos.y, 3.2, delta);
      camera.position.z = THREE.MathUtils.damp(camera.position.z, _camTargetPos.z, 3.2, delta);
      camera.lookAt(_lookAtTarget);

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handlePointerMove);
      silkGeo.dispose();
      silkMat.dispose();
      backSilkGeo.dispose();
      backSilkMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      particleGeo.dispose();
      particleMat.dispose();
      burstGeo.dispose();
      burstMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="fixed inset-0 w-full h-full pointer-events-none z-0"
      aria-label="Real-time 3D Audio-Reactive Silk Wave and Harmonic Halo Visualizer"
    />
  );
}
