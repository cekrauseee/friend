# Friend

A minimal voice interface built with React, TypeScript, and Vite. The current version is a local microphone demo: a small pixel orb sits in the center of a charcoal screen, with a single microphone button below it.

The interface uses neutral colors, solid controls, and restrained motion. There is no visible copy in its normal state. Accessible labels and contextual errors are in English.

## Run

Use Node.js 22.18+ and pnpm.

```sh
pnpm install
pnpm dev
```

Open the localhost URL printed by Vite. Click the microphone button and grant browser permission. The orb responds to your voice's volume. Click again to stop. A second click also cancels a pending permission request.

Microphone access requires localhost or HTTPS. Rendering requires WebGL. Browser errors appear in English only when needed; the normal interface has no visible text.

## Audio

Audio stays in the browser. There is no recording, transcription, playback, network upload, or agent backend in this version. A Web Audio analyser measures speech energy and drives the orb's live volume and motion parameters.

Tracks, audio nodes, and the audio context are released on stop, page exit, or component unmount. Late permission responses are discarded after cancellation. The orb respects the system's reduced-motion setting.

## Orb component

Installed with the requested registry command:

```sh
pnpm dlx shadcn@latest add zzzzshawn/orbkit/shdr-14
```

Source: [Orbkit](https://github.com/zzzzshawn/orbkit). The shader and renderer are in `src/components/ui/`. Unused gallery exports were removed to keep these files compatible with Vite's Fast Refresh checks; shader behavior is unchanged.

## Project structure

- `src/App.tsx` composes the orb and microphone control.
- `src/App.css` defines the page layout and interaction states.
- `src/index.css` contains the shared visual tokens.
- `src/hooks/use-microphone.ts` connects React to the audio lifecycle.
- `src/lib/microphone.ts` owns microphone permission, audio analysis, cancellation, and cleanup.
- `src/components/ui/` contains the adapted Orbkit and shadcn components.
- `tests/microphone.test.mjs` exercises audio behavior with browser API test doubles.

Keep audio resource management outside UI components. The microphone must only start after a user action and must release all resources when stopped. Do not commit local environment files or credentials.

## Checks

```sh
pnpm test
pnpm lint
pnpm build
```

The Node.js tests cover signal normalization, microphone lifecycle, permission denial and retry, cancellation, stale permission responses, disconnection, startup failure, and unsupported environments using audio API test doubles. Real microphone and visual browser checks are separate manual checks.

Third-party source licenses are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
