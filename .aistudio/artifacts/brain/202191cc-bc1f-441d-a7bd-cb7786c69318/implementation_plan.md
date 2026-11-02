# Implementation Plan: MuseVis Audio

MuseVis Audio is an immersive music application that enhances the listening experience by combining Spotify integration with real-time, responsive 3D abstract art and ambient lighting derived from the current song's metadata and mood.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following choices were confirmed in the planning phase:
> - **Platform Integration**: Spotify (primary focus).
> - **Visual Style**: Minimalist and fluid abstract art.

- **[Decision Needed] Lyrics Provider**: I plan to use a reputable lyrics API (e.g., Genius or a similar service via a server-side proxy).
- **[Decision Needed] Theme Color Extraction**: I will implement a server-side color extraction service to analyze album art for dynamic ambient theme generation.

## 1. Overview & Core Concept

- **What It Does**: Connects to the user's Spotify account, visualizes music rhythm and mood with procedural 3D fluid art, extracts color palettes from album art for ambient lighting, and displays synchronized lyrics.
- **Target Audience**: Music enthusiasts who appreciate immersive, aesthetic, and atmospheric listening experiences.
- **Key Value**: Transforms passive listening into a cinematic, audio-visual experience.

## 2. User Experience & Visual Design

- **Key User Flows**:
    1. Authenticate with Spotify.
    2. Select/Play a track from the library.
    3. View the 3D fluid abstract visualizer, which morphs based on tempo.
    4. View synchronized lyrics in a clean, unobtrusive overlay.
    5. Ambient lighting shifts colors dynamically based on the current track's album art.
- **Visual Identity & Theme**:
    - *Aesthetic Direction*: Minimalist, elegant, and fluid abstract art.
    - *Color Palette & Mood*: Dynamic, extracted from album art, using dark backgrounds (`--background: #0a0a0a`) and subtle accents.
    - *Typography & Hierarchy*: Clean, modern sans-serif (e.g., 'Plus Jakarta Sans') for readability.
    - *Component Styling & Layout*: Collapsible bottom dock for playback controls to keep the 3D viewport unobstructed.
- **Interactive Feedback & Motion**: Smooth exponential damping for all 3D transitions and UI movements.

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Spotify OAuth**:
    - *Approach*: Server-side proxy with client-side popup flow as per `oauth-integration` guidelines.
    - *Why*: Secure, reliable authentication in an iframe context.
- **Decision 2: 3D Visualization**:
    - *Approach*: Three.js using `ShaderMaterial` for high-performance, fluid motion.
    - *Why*: Flexibility and aesthetic quality; `ShaderMaterial` allows for highly performant procedural animation.

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────┐
│                 Client-Side (React/Vite)               │
│ ┌────────────────┐ ┌──────────────────┐ ┌─────────────┐│
│ │ Spotify Auth   │ │ Lyrics / Metadata│ │ Three.js Art││
│ └───────┬────────┘ └────────┬─────────┘ └──────┬──────┘│
│         │                   │                  │       │
│         └──────────┬────────┴─────────┬────────┘       │
│                    ▼                  ▼                │
│           ┌─────────────────────────────────────┐      │
│           │ App.tsx (Main orchestrator)         │      │
│           └────────────────┬────────────────────┘      │
│                            │                           │
│ ┌──────────────────────────▼──────────────────────────┐│
│ │ Server Proxy Routes (server.ts)                     ││
│ │ └─ /api/spotify/*                                   ││
│ └─────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────┘
```

- **Data Model & State**: Spotify API handles track/artist metadata. Color extraction service provides theme colors.
- **Interactive Component & State Mapping**: React `useEffect` hooks manage playback state, which in turn triggers 3D shader uniform updates.
- **Key Sequences & Integrations**:
    1. OAuth: Follow mandatory `set_up_oauth` flow (Phase 1: `userConfirmedInUI: false`, Phase 2: `userConfirmedInUI: true`).
    2. Visualization: `Three.js` loop synchronizes with audio playback data.
