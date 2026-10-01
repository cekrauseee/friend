# Dot

A minimal voice and text companion built with React, TypeScript, and Vite. Start a call, speak naturally, and hear the model respond. A small pixel orb reacts to the model's audio; fixed waveform bars react to your microphone.

The interface follows the system’s light or dark appearance, with neutral surfaces, solid controls, and restrained motion. The call button turns red when it ends or cancels a call. Text replies render in a shared transcript; controls, accessible labels, and contextual errors are in English.

The [portfolio case study](.portfolio/project.md) documents the interaction, architecture, and current scope.

## Run locally

Use Node.js 22.18+ and pnpm.

```sh
pnpm install
pnpm run setup
```

Setup creates `.env.local` or updates it to follow the comments and variable order in `.env.example`. Existing values, including empty values, quotes and multiline values, are preserved. Missing variables receive the example defaults; custom variables and local notes remain at the end. Re-run `pnpm run setup` whenever the example changes. An up-to-date file is left untouched, and logs never show values. The command only synchronizes the local environment file; it does not install dependencies, obtain keys, or configure hosted agents. Use `pnpm run setup`, since `pnpm setup` is pnpm's own installation command.

Voice and dictation default to OpenAI: set `OPENAI_API_KEY` in `.env.local` to an existing project key with access to the required models. To use ElevenLabs dictation, set `DOT_TRANSCRIPTION_PROVIDER=elevenlabs` and `ELEVENLABS_API_KEY` with Scribe v2 access. To use ElevenAgents calls, set `DOT_VOICE_PROVIDER=elevenlabs`, the same server-only `ELEVENLABS_API_KEY`, and `ELEVENLABS_AGENT_ID` as described below. The two selections are independent and their ElevenLabs paths require no OpenAI key. Text chat in development uses your ChatGPT account through Codex CLI 0.156.1 on `PATH`; it does not need an API key. Then run:

```sh
pnpm dev
```

Open the localhost URL printed by Vite. Select the phone button. The app checks the selected provider’s local configuration before showing the call waveform; ElevenLabs also validates the agent and obtains its token first. Allow microphone access when startup proceeds. When connected, speak normally. Select the red button to end the call. Selecting it while connecting cancels setup.

Keys and provider settings are read only by the local server. Never use a `VITE_` prefix for them; that would expose them to the browser. Environment files are ignored by Git. Restart the development server after changing configuration.

Microphone access requires a supported browser on localhost or HTTPS. The orb requires WebGL. Calls are billed by the selected provider under the configured account; ElevenAgents usage includes its hosted conversation services.

## Text chat in development

The app opens on a shared conversation screen. Startup checks server-confirmed authentication behind a centered spinner. With the Codex provider, a shadcn AlertDialog handles sign-in when needed; its action opens the ChatGPT authentication popup and waits for the server to confirm success. Existing sessions proceed immediately. Refusal, cancellation, timeout, and connection errors keep the dialog available for retry. Allow pop-ups for localhost. Closing the authentication window may only be detected by the three-minute timeout because authentication pages can sever browser window references.

Selecting chat opens the composer. Typing anywhere outside another editable field or a modal opens and focuses it without losing the first character. Control/Command+A and V target the composer; Control+Backspace deletes the preceding word and Command+Backspace deletes the current line prefix. Existing fields, native control activation, browser shortcuts, and active voice calls retain their own keyboard behavior. The composer uses “Ask anything”, expands for multiline drafts, and stays open once messages exist. During calls, chat yields to a 36px waveform and the call control. Voice errors dismiss after six seconds or a state change.

User messages appear as right-aligned bubbles. Assistant replies use semantic Markdown styled with shadcn Typeset, simple syntax-highlighted code containers, and Mermaid diagrams. Code and table toolbars are omitted. The small agent orb stays below the latest response and smoothly moves as its height changes. The large initial orb is removed after the first message.

On send, a bottom spacer creates just enough scroll reach to align the new user message near the top, including when the transcript is shorter than the viewport. Remaining spacer is reused without accumulation. Reply growth and upward reader scroll consume it irreversibly; retry does not replenish it. Streaming never follows the response automatically. The reader can use the centered jump-to-latest control for an explicit smooth jump to the real content end. Scrollbars are hidden while native wheel, touch and keyboard scrolling remain available, with content padding inside the transcript and a short fade above the composer.

Incoming deltas are buffered for display with a seeded, non-cyclic rhythm. The visual clock keeps its phase across short gaps and adds brief, single-use pauses at prose boundaries; code does not receive prose pauses. Chunk sizes increase with backlog and content age. The presentation targets 200ms of lag, releases content aged 350ms at the next scheduled deadline, and drains the remaining queue within 250ms of transport completion while the scheduler is running. Text, Markdown whitespace, and Unicode graphemes are preserved. The turn remains active until displayed text drains, so completion feedback and future conversation context agree with the visible response. Canceling discards pending display work; retry starts a fresh attempt.

UI SFX uses the Zen pack with a quiet master gain. Typing, sending, completion, retry, errors, sign-in, and call-ending feedback use short semantic cues; hover and scrolling stay silent. Agent typing selects sounds only on newly displayed content, with variable eligibility, occasional omissions, and small gain/rate changes. Recovery and final draining reduce its gain. Interface effects are suspended during voice calls and hidden-page updates. The accessible sound toggle persists its preference in localStorage; transcript and audio are not persisted. Existing mute preferences from the previous project name are preserved.

Use `DOT_TEXT_PROVIDER=codex` (the development default) or `DOT_TEXT_PROVIDER=api` in `.env.local`, then restart Vite. The API option uses the existing project key and its API billing. OpenAI voice and OpenAI dictation use that key; ElevenLabs voice and dictation use their independent provider selections with the server-only ElevenLabs key. Dictation does not use Codex or ChatGPT authentication. There is no fallback from a failed Codex request to the API. For `pnpm preview`, explicitly select `DOT_TEXT_PROVIDER=api`; selecting Codex outside development is rejected. Production builds contain no Codex backend and require a separate server for chat.

The Codex integration requires **Codex CLI 0.156.1**. This version is checked during initialization because environment isolation is verified against its protocol; other versions fail closed. Install that version through the official [Codex CLI instructions](https://learn.chatgpt.com/docs/cli). After upgrading the adapter, re-run the local CLI protocol test before changing the supported version.

Dot starts one local `codex app-server` process on demand. It uses Codex-managed ChatGPT authentication and a separate `CODEX_HOME` at `~/.local/share/dot/codex`, so signing in to the desktop app or another CLI profile does not sign you in here. Codex stores its managed credentials there; do not commit or share that directory. To sign out, stop Vite and run `CODEX_HOME="$HOME/.local/share/dot/codex" codex logout`. Existing profiles from the previous project name are reused automatically; for those profiles, use their existing directory when running logout. The child inherits only `PATH` and this dedicated `CODEX_HOME`. Tokens and raw upstream errors never reach the browser.

Every reply requests `gpt-6-luna` with reasoning `none`. Account authentication permits sending text messages; it does not prove access to the model. Only a completed inference proves model access for that request. Model or subscription limits appear as reply errors, without changing the model or provider. Live account access has not been verified by the automated tests.

Each request starts an ephemeral Codex thread and passes the browser's accepted message history as a JSON conversation. Completed user/assistant pairs supply context; failed partial replies are excluded by the existing conversation store. No thread identifier or token is sent to the browser. The thread is unsubscribed after completion, failure, or cancellation. The app interrupts active turns when the browser leaves or cancels a reply. Conversation state remains in browser memory; the app does not create saved Codex chats.

Codex is an agent protocol, so its tool contract differs from the API's `tools: []` / `tool_choice: none`. Dot supplies `environments: []`, empty dynamic tools and workspace roots, disables agents, apps, plugins, shell and other capabilities, and uses read-only access with approvals set to never. With the supported CLI, no shell, file editing, browser, MCP or subagent tool is exposed. Codex retains internal V8 orchestration (without filesystem/network access), clock/skill helpers and input requests. Dot rejects server-initiated requests and never asks the browser to approve or execute tools. The CLI test verifies the actual outbound tool catalog against a local mock endpoint; it performs no OpenAI inference or login.

This is a localhost development integration using [Codex app-server authentication](https://learn.chatgpt.com/docs/app-server). Review the official [ChatGPT plan integration guidance](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) before extending it to distribution or hosted use.

## Dictation

Select the microphone beside the chat control or composer to dictate a text message. Allow microphone access; the composer keeps its existing draft while the LiveWaveform shows local microphone activity. The same canvas remains mounted during microphone startup and transcription, using a processing wave without visible status labels. Reduced motion uses a static waiting pattern; screen-reader announcements still describe each state. Calls and dictation cannot run together. The phone control disappears once the text conversation contains messages.

- **Stop** transcribes the recording, appends the trimmed transcript to the existing draft, and returns focus to editing without sending. A space separates the draft and transcript unless the draft already ends in whitespace.
- **Check** transcribes and submits that same merged draft through the existing text conversation. The draft clears only when the conversation accepts the send; a rejected send leaves the merged text available to edit. An accepted turn that later fails uses the existing retry behavior.
- **Cancel** discards the recording or aborts transcription and preserves the original draft. On the initial orb screen, an empty draft returns to compact controls; existing drafts and conversations return to the editable composer. Cancellation, page exit, authentication changes and stale results cannot insert or send text.

Recording stays in browser memory until Stop or Check. The completed WebM or MP4 recording is sent once to `POST /api/transcription`. `DOT_TRANSCRIPTION_PROVIDER=openai` uses `gpt-transcribe` with `OPENAI_API_KEY`; `DOT_TRANSCRIPTION_PROVIDER=elevenlabs` uses Scribe v2 (`scribe_v2`) with `ELEVENLABS_API_KEY`, independently of text chat and voice calls. Omitting the variable selects OpenAI. Explicit blank or unknown values fail at server startup. A missing selected key produces a recoverable configuration error, with no fallback to another provider. ElevenLabs detects the language automatically; audio-event tagging and speaker diarization are disabled. The server accepts raw audio bytes from matching localhost origins, validates the container, and returns trimmed nonempty text. It holds audio only in bounded memory, sends no-store responses, and does not save recordings or transcripts. Uploaded audio remains subject to the selected provider's account data policy, retention settings and billing; local memory-only handling does not guarantee upstream deletion or zero retention.

Each recording is limited to five minutes and 25,000,000 bytes. Exceeding either bound discards it locally without uploading. Microphone startup times out after 30 seconds; the server allows two minutes for collection and transcription, while the browser stops waiting after 130 seconds. Permission, unsupported format, empty recording/transcript, configuration, access, rate-limit and network failures leave the draft intact. Recording errors remain beside the composer until dismissed or retried. Cancel stays available during startup and processing; duplicate finishing actions are ignored.

Stopping capture releases microphone tracks and its audio meter before upload. Cancellation, failures, unmount and page exit also clear timers, recorded chunks and audio resources, and abort pending requests.

## OpenAI configuration

The server configures voice sessions in [`server/session-config.ts`](server/session-config.ts) and the OpenAI dictation adapter in [`server/transcription-provider.ts`](server/transcription-provider.ts):

| Setting | Value |
| --- | --- |
| Voice model | `gpt-live-1` |
| Responses backend | `gpt-6-luna` |
| Dictation model | `gpt-transcribe` |
| Backend reasoning effort | `none` |
| Tools | None |
| Tool choice | `none` |

GPT-Live handles the spoken conversation and delegates to Luna when needed. Voice, instructions, and other model settings use OpenAI's defaults. The voice/API paths have no custom tools or system prompts. The Codex adapter supplies a short instruction to continue the provided text conversation. There are no model selectors or advanced settings in the interface.

## ElevenAgents voice configuration

Set `DOT_VOICE_PROVIDER=elevenlabs` to use ElevenAgents for calls, or `openai` (the default) to retain GPT-Live. This selection is independent of `DOT_TEXT_PROVIDER` and `DOT_TRANSCRIPTION_PROVIDER`. Invalid provider values fail during server initialization; failures never switch providers automatically. ElevenAgents voice does not require an OpenAI API key or OpenAI credits. API text chat and OpenAI dictation retain their separate requirements.

Use an existing published ElevenAgents agent with `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` on the server. Configure that agent in ElevenLabs with:

- Speech model `eleven_v4_turbo` (Eleven v4 Turbo), including any supported voices and language presets.
- A native LLM served through ElevenLabs; custom LLM endpoints are rejected. Eleven v4 Turbo supplies speech, while the agent's LLM generates replies. Recording transcription is a separate operation.
- Audio enabled, first-message interruptions allowed, and client events `user_transcript`, `agent_response`, `agent_response_correction`, and `interruption` enabled.
- No workflows, which could transfer to a different agent or override the checked speech engine. Language presets must retain the required speech, native LLM, audio, interruption and event configuration.

Dot reads and validates the existing agent before each call, requires a published version, and requests a WebRTC conversation token pinned to that validated version. It does not create or modify hosted agents. Agent prompts, voice, native LLM and other supported settings come from the existing agent. Missing credentials, invalid configuration, unavailable model access or account limits produce recoverable call errors. Account entitlement and hosted configuration must be established separately; automated tests do not prove access to Eleven v4 Turbo.

## Connection and audio

For OpenAI calls, the browser captures the microphone once and creates a WebRTC connection. A local `POST /api/session` endpoint exchanges its SDP offer with OpenAI using the official TypeScript SDK. The API key and model configuration stay on the server. The browser receives only the session ID and SDP answer.

Microphone audio travels to OpenAI over the WebRTC media track. A local analyser supplies the waveform's frequency bands without recording or scrolling history. Bars follow speech quickly and settle gradually in silence. A native audio element plays the remote model stream, while a separate analyser measures it for the orb. Chrome needs the media player to consume the remote stream; a Web Audio analyser alone can remain silent even while WebRTC receives packets. Microphone input never drives the orb or plays through the speakers. If the browser blocks playback or the player later stops or fails, the call ends with an actionable error and releases the microphone.

An OpenAI call becomes ready on `session.started`. Ending it silences both sides, sends `session.close`, and waits for `session.closed` before releasing the connection. A bounded timeout releases resources if finalization cannot be confirmed. Canceled startup, denied permissions, disconnects, unmounts, and page exit also release local resources. Leaving the page closes the transport immediately and cannot wait for final acknowledgment.

For ElevenAgents, `GET /api/voice-provider` discovers the server selection and `POST /api/elevenlabs-session` returns only the validated model and a short-lived conversation token. The API key stays on the server. The official `@elevenlabs/client` 1.26.0 SDK owns WebRTC microphone capture, playback and audio analysers. The waveform uses its microphone frequency data; the orb uses its output volume only while the agent speaks and clears on interruption. The app does not add a second microphone capture or playback path. Ending a connected call mutes microphone and output, then waits for SDK cleanup before allowing another call or dictation.

Provider discovery and token requests abort immediately on cancellation. The SDK exposes no public early-abort handle once startup begins. Canceling, leaving the page or reaching the connection deadline invalidates callbacks and closes any late conversation handle. While mounted, the interface stays closing and excludes dictation/new calls until startup and cleanup settle. If SDK startup never settles, that state can persist; synchronous microphone release before the SDK exposes its handle cannot be guaranteed.

Dot does not persist audio or transcripts and does not request OpenAI session storage. Conversation audio goes directly to the selected provider and remains subject to that account's data policy and billing. ElevenAgents retention follows the hosted agent/account settings; Dot does not override them.

## Project structure

- `src/App.tsx` composes the interface.
- `src/components/dot-orb.tsx` visualizes model audio.
- `src/components/call-button.tsx` presents call actions.
- `src/components/microphone-waveform.tsx` presents the fixed microphone waveform.
- `src/hooks/use-live-session.ts` connects React to the session lifecycle.
- `src/lib/voice-session.ts` selects the server-configured engine and maintains the shared call lifecycle.
- `src/lib/elevenlabs-conversation.ts` adapts the official ElevenAgents SDK.
- `src/lib/live-session.ts` owns OpenAI WebRTC, events, cancellation, and cleanup.
- `src/lib/audio-meter.ts` analyses input and output streams separately.
- `src/lib/webrtc.ts` waits for ICE gathering.
- `server/session-config.ts` holds the model configuration.
- `server/live-api.ts` validates local requests and calls the OpenAI SDK.
- `server/voice-api.ts` validates ElevenAgents configuration and returns version-pinned conversation tokens.
- `server/transcription-api.ts` validates bounded recordings and requests transcription.
- `server/transcription-provider.ts` adapts OpenAI GPT Transcribe and ElevenLabs Scribe v2 behind the same recording contract.
- `src/lib/audio-capture.ts` owns local recording, frequency bands, cancellation, and cleanup.
- `src/lib/transcription-client.ts` uploads completed recordings and handles safe transcription errors.
- `src/hooks/use-audio-capture.ts` connects React to the capture lifecycle.
- `src/hooks/use-composer-dictation.ts` applies transcripts to drafts and accepted text sends.
- `server/codex-process.ts` manages the isolated Codex stdio process.
- `server/codex-provider.ts` owns ChatGPT authentication and text streaming.
- `src/lib/text-access.ts` owns startup authentication and sign-in state.
- `src/components/text-conversation-view.tsx` presents the unified transcript, composer, and call controls.
- `src/components/compact-agent-orb.tsx` follows the height of the latest reply below its content.
- `src/components/assistant-markdown.tsx` and `src/typeset.css` render semantic Markdown.
- `src/components/markdown-code-block.tsx` provides the simple highlighted code surface.
- `src/lib/text-conversation.ts` owns in-memory turns, accepted context, retry, and cancellation.
- `src/lib/paced-text.ts` and `src/lib/stream-rhythm.ts` control incremental presentation.
- `src/lib/conversation-spacer.ts` owns send alignment and irreversible spacer consumption.
- `src/lib/conversation-scroll-motion.ts` animates only explicit send/jump commands.
- `src/hooks/use-composer-shortcuts.ts` routes page-level text editing to the composer.
- `src/lib/interface-sounds.ts` and `src/lib/agent-typing.ts` own sound preferences and event-bound typing selection.
- `server/vite-plugin.ts` selects the local text and transcription providers and mounts the routes.
- `src/components/ui/` contains the adapted source components.

Keep session and audio resource management outside the UI components.

## Interface style guide

The interface uses shadcn/ui Radix Rhea, Inter, pointer cursors, and semantic neutral tokens in both system appearances. Icon controls share the `icon-lg` variant (36px); the waveform matches that height and the global spinner uses 16px. Messages and the composer share a 448px content measure, with safe-area padding inside the transcript rather than around its scrollbar.

Application-specific geometry stays in the conversation components and CSS. Composer resizing and orb repositioning use the shared 160ms morph transition. Bubble, navigation-control, and interface entrances share a restrained spring; exits are shorter and quieter. Reduced motion removes spatial movement. The first-send transition retains the mounted scrollport while the initial orb recedes and the composer moves into its conversation position.

Typography is defined by the owned shadcn Typeset stylesheet and the chat preset. Rich text keeps native heading, paragraph, list, quote, rule, and table semantics. Code blocks are selectable, keyboard-scrollable containers without file actions. Sound reinforces the existing visible states and can be muted independently of motion preferences.

## Checks

```sh
pnpm test
pnpm lint
pnpm build
```

Tests use Node.js's built-in runner and test doubles for browser audio, WebRTC, ElevenAgents SDK and provider requests. They cover selected voice engines, validated/version-pinned tokens, delayed SDK startup and microphone exclusion, voice resources, deferred dictation uploads, recording bounds and cleanup, transcript draft/send behavior, authentication/provider boundaries, turn lifecycle, paced display, spacer geometry, explicit scrolling, keyboard routing, Markdown semantics, sound selection, and preference compatibility. They make no live API calls.

Unit tests do not verify audible browser playback, real microphone recording or live transcription. Real voice conversations and dictation requests are separate manual checks with their selected provider configuration. ElevenAgents account/model entitlement, microphone permissions, autoplay, audible playback and audio quality remain unverified by automated checks. Scribe v2 account entitlement, language detection, transcription quality and upstream retention have not been verified with live requests.

The test suite uses simulated authentication and inference. If Codex CLI 0.156.1 is installed, it also runs a local HTTP protocol test; otherwise that test is skipped. No test requires a ChatGPT account or an API key. Live login, real model entitlement, popup behavior and visual QA require a separate manual check.

## Build and preview

```sh
pnpm build
DOT_TEXT_PROVIDER=api pnpm preview
```

Preview serves the production frontend with the local voice, text and transcription API-key endpoints. The generated `dist/` directory alone cannot create voice sessions. This project currently supports local use: session creation accepts matching localhost origins. Hosting for other users requires a trusted backend with application authentication and request controls; this repository does not include a production deployment.

## Source components

The orb is [Orbkit SHDR-14](https://github.com/zzzzshawn/orbkit), installed with:

```sh
pnpm dlx shadcn@latest add zzzzshawn/orbkit/shdr-14
```

The waveform is adapted from [ElevenLabs UI LiveWaveform](https://ui.elevenlabs.io/docs/components/live-waveform). Its documented installation is:

```sh
pnpm dlx @elevenlabs/cli@latest components add live-waveform
```

The owned adaptation retains the fixed-position bars and processing pattern, receiving measured audio data from the existing capture/session. It opens no extra microphone and keeps one canvas across recording states. The official source is in [the ElevenLabs UI repository](https://github.com/elevenlabs/ui/blob/main/apps/www/registry/elevenlabs-ui/ui/live-waveform.tsx).

Orbkit's unused gallery exports were removed for Vite Fast Refresh compatibility.

Original source licenses are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## API references

- [ElevenLabs speech-to-text endpoint](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [ElevenAgents JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script)
- [ElevenAgents WebRTC conversation tokens](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-webrtc-token)
- [ElevenLabs models](https://elevenlabs.io/docs/overview/models)
- [ElevenAgents LLM configuration](https://elevenlabs.io/docs/eleven-agents/customization/llm)
- [Speech-to-text transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
- [GPT Transcribe model](https://developers.openai.com/api/docs/models/gpt-transcribe)
- [GPT-Live WebRTC connection](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Responses delegation and supported configuration](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT-6 Luna reasoning settings](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Session lifecycle and graceful close](https://developers.openai.com/api/docs/guides/live-conversations)
