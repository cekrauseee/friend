# Friend

A minimal voice and text companion built with React, TypeScript, and Vite. Start a call, speak naturally, and hear the model respond. A small pixel orb reacts to the model's audio; fixed waveform bars react to your microphone.

The interface uses a charcoal background, solid controls, and restrained motion. The call button turns red when it ends or cancels a call. There is no visible copy in normal operation. Accessible labels and contextual errors are in English.

The [portfolio case study](.portfolio/project.md) documents the interaction, architecture, and current scope.

## Run locally

Use Node.js 22.18+ and pnpm.

```sh
pnpm install
cp .env.example .env.local
```

For voice calls, set `OPENAI_API_KEY` in `.env.local` to an existing OpenAI project key with GPT-Live access. Text chat in development uses your ChatGPT account through Codex CLI 0.156.1 on `PATH`; it does not need an API key. Then run:

```sh
pnpm dev
```

Open the localhost URL printed by Vite. Select the phone button and allow microphone access. When connected, speak normally. Select the red button to end the call. Selecting it while connecting cancels setup.

The key is read only by the local server. Never use a `VITE_` prefix for it; that would expose it to the browser. Environment files are ignored by Git. Restart the development server after changing the key.

Microphone access requires a supported browser on localhost or HTTPS. The orb requires WebGL. OpenAI API access and usage are billed to the configured project.

## Text chat in development

The text conversation button checks access before opening the conversation. If you have not signed in, it opens ChatGPT sign-in in another window. Allow pop-ups for localhost. The main screen remains visible until the local server confirms a ChatGPT account. Refusal, cancellation, timeout, or a failed local connection shows an error beside the button. Select the button again during login to cancel; select it after an error to retry. Closing the sign-in window may only be detected by the three-minute timeout because authentication pages can sever browser window references.

Use `FRIEND_TEXT_PROVIDER=codex` (the development default) or `FRIEND_TEXT_PROVIDER=api` in `.env.local`, then restart Vite. The API option uses the existing project key and its API billing. Voice always uses that key. There is no fallback from a failed Codex request to the API. For `pnpm preview`, explicitly select `FRIEND_TEXT_PROVIDER=api`; selecting Codex outside development is rejected. Production builds contain no Codex backend and require a separate server for chat.

The Codex integration requires **Codex CLI 0.156.1**. This version is checked during initialization because environment isolation is verified against its protocol; other versions fail closed. Install that version through the official [Codex CLI instructions](https://learn.chatgpt.com/docs/cli). After upgrading the adapter, re-run the local CLI protocol test before changing the supported version.

Friend starts one local `codex app-server` process on demand. It uses Codex-managed ChatGPT authentication and a separate `CODEX_HOME` at `~/.local/share/friend/codex`, so signing in to the desktop app or another CLI profile does not sign you in here. Codex stores its managed credentials there; do not commit or share that directory. To sign out, stop Vite and run `CODEX_HOME="$HOME/.local/share/friend/codex" codex logout`. The child inherits only `PATH` and this dedicated `CODEX_HOME`. Tokens and raw upstream errors never reach the browser.

Every reply requests `gpt-6-luna` with reasoning `none`. Account authentication permits entering the text view; it does not prove access to the model. Only a completed inference proves model access for that request. Model or subscription limits appear as reply errors, without changing the model or provider. Live account access has not been verified by the automated tests.

Each request starts an ephemeral Codex thread and passes the browser's accepted message history as a JSON conversation. Completed user/assistant pairs supply context; failed partial replies are excluded by the existing conversation store. No thread identifier or token is sent to the browser. The thread is unsubscribed after completion, failure, or cancellation. The app interrupts active turns when the browser leaves or cancels a reply. Conversation state remains in browser memory; the app does not create saved Codex chats.

Codex is an agent protocol, so its tool contract differs from the API's `tools: []` / `tool_choice: none`. Friend supplies `environments: []`, empty dynamic tools and workspace roots, disables agents, apps, plugins, shell and other capabilities, and uses read-only access with approvals set to never. With the supported CLI, no shell, file editing, browser, MCP or subagent tool is exposed. Codex retains internal V8 orchestration (without filesystem/network access), clock/skill helpers and input requests. Friend rejects server-initiated requests and never asks the browser to approve or execute tools. The CLI test verifies the actual outbound tool catalog against a local mock endpoint; it performs no OpenAI inference or login.

This is a localhost development integration using [Codex app-server authentication](https://learn.chatgpt.com/docs/app-server). Review the official [ChatGPT plan integration guidance](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) before extending it to distribution or hosted use.

## OpenAI configuration

The server configures the session in [`server/session-config.ts`](server/session-config.ts):

| Setting | Value |
| --- | --- |
| Voice model | `gpt-live-1` |
| Responses backend | `gpt-6-luna` |
| Backend reasoning effort | `none` |
| Tools | None |
| Tool choice | `none` |

GPT-Live handles the spoken conversation and delegates to Luna when needed. Voice, instructions, and other model settings use OpenAI's defaults. The voice/API paths have no custom tools or system prompts. The Codex adapter supplies a short instruction to continue the provided text conversation. There are no model selectors or advanced settings in the interface.

## Connection and audio

The browser captures the microphone once and creates a WebRTC connection. A local `POST /api/session` endpoint exchanges its SDP offer with OpenAI using the official TypeScript SDK. The API key and model configuration stay on the server. The browser receives only the session ID and SDP answer.

Microphone audio travels to OpenAI over the WebRTC media track. A local analyser supplies the waveform's frequency bands without recording or scrolling history. Bars follow speech quickly and settle gradually in silence. A native audio element plays the remote model stream, while a separate analyser measures it for the orb. Chrome needs the media player to consume the remote stream; a Web Audio analyser alone can remain silent even while WebRTC receives packets. Microphone input never drives the orb or plays through the speakers. If the browser blocks playback or the player later stops or fails, the call ends with an actionable error and releases the microphone.

The call becomes ready on `session.started`. Ending it silences both sides, sends `session.close`, and waits for `session.closed` before releasing the connection. A bounded timeout releases resources if finalization cannot be confirmed. Canceled startup, denied permissions, disconnects, unmounts, and page exit also release local resources. Leaving the page closes the transport immediately and cannot wait for final acknowledgment.

Friend does not persist audio or transcripts and does not request OpenAI session storage. Audio is sent to OpenAI for the conversation and remains subject to the configured project's API data policy.

## Project structure

- `src/App.tsx` composes the interface.
- `src/components/friend-orb.tsx` visualizes model audio.
- `src/components/call-button.tsx` presents call actions.
- `src/components/microphone-waveform.tsx` presents the fixed microphone waveform.
- `src/hooks/use-live-session.ts` connects React to the session lifecycle.
- `src/lib/live-session.ts` owns WebRTC, events, cancellation, and cleanup.
- `src/lib/audio-meter.ts` analyses input and output streams separately.
- `src/lib/webrtc.ts` waits for ICE gathering.
- `server/session-config.ts` holds the model configuration.
- `server/live-api.ts` validates local requests and calls the OpenAI SDK.
- `server/codex-process.ts` manages the isolated Codex stdio process.
- `server/codex-provider.ts` owns ChatGPT authentication and text streaming.
- `src/lib/text-access.ts` gates text-mode entry on confirmed access.
- `server/vite-plugin.ts` selects the local text provider and mounts the routes.
- `src/components/ui/` contains the adapted source components.

Keep session and audio resource management outside the UI components.

## Checks

```sh
pnpm test
pnpm lint
pnpm build
```

Tests use Node.js's built-in runner and test doubles for browser audio, WebRTC, and OpenAI requests. They cover only the core session contract, separation of input/output audio, cancellation, cleanup, and necessary request/error handling. They make no live API calls.

Unit tests do not verify audible browser playback. A real voice conversation is a separate manual check with a configured OpenAI API key.

The test suite uses simulated authentication and inference. If Codex CLI 0.156.1 is installed, it also runs a local HTTP protocol test; otherwise that test is skipped. No test requires a ChatGPT account or an API key. Live login, real model entitlement, popup behavior and visual QA require a separate manual check.

## Build and preview

```sh
pnpm build
FRIEND_TEXT_PROVIDER=api pnpm preview
```

Preview serves the production frontend with the local voice and text API-key endpoints. The generated `dist/` directory alone cannot create voice sessions. This project currently supports local use: session creation accepts matching localhost origins. Hosting for other users requires a trusted backend with application authentication and request controls; this repository does not include a production deployment.

## Source components

The orb is [Orbkit SHDR-14](https://github.com/zzzzshawn/orbkit), installed with:

```sh
pnpm dlx shadcn@latest add zzzzshawn/orbkit/shdr-14
```

The waveform comes from [ElevenLabs UI](https://github.com/elevenlabs/ui). Its documented installation is:

```sh
pnpm dlx @elevenlabs/cli@latest components add waveform
```

The hosted registry was rate-limited during setup, so the identical published registry item was installed from the official GitHub repository:

```sh
pnpm dlx shadcn@latest add https://raw.githubusercontent.com/elevenlabs/ui/main/apps/www/public/r/waveform.json
```

Only the base `Waveform` renderer is retained. It displays live frequency data at fixed positions; the scrolling, synthetic, recording, and additional microphone-capture variants are omitted. Orbkit's unused gallery exports were removed for Vite Fast Refresh compatibility.

Original source licenses are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## API references

- [GPT-Live WebRTC connection](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Responses delegation and supported configuration](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT-6 Luna reasoning settings](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Session lifecycle and graceful close](https://developers.openai.com/api/docs/guides/live-conversations)
