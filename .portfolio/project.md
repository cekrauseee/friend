---
slug: dot
portfolioIndex: 8
name: Dot
repositoryUrl: https://github.com/cekrauseee/friend
description: >-
  A minimal voice and text companion with paced replies, restrained motion,
  and separate visual feedback for listening and speaking.
metaDescription: >-
  Dot explores voice conversation with GPT-Live-1, WebRTC, a reactive pixel
  orb, and a small server-side boundary for session creation.
summary: >-
  Dot starts with a small interaction: begin a call, speak naturally, and
  hear the model respond. A pixel orb follows the model's audio, while fixed
  waveform bars show microphone activity. The local prototype keeps session
  management separate from its React components and keeps API credentials on
  the server.
highlights:
  - GPT-Live-1 voice sessions with a GPT-6 Luna backend
  - separate visual feedback for microphone input and model output
  - native browser audio playback and explicit resource cleanup
  - a minimal interface with a local signaling endpoint
---

## A voice companion with a small interface

Dot is a browser-based voice experiment centered on a pixel orb and a single
call control. Starting a call reveals a fixed waveform for the microphone. The
orb responds to the model's audio, keeping the two sides of voice conversation
visually distinct. Text conversation shares the same screen, with a persistent
composer, user bubbles, and assistant Markdown.

The interface uses neutral colors and solid controls. The call button turns red
when it ends or cancels a session. Text replies use semantic typography and simple code containers; accessible
labels and contextual errors explain controls and failures.
The orb adapts the Orbkit SHDR-14 shader, and the waveform uses the base renderer
from ElevenLabs UI with centered bars and a gradual release into silence.

## Text that follows the reader's pace

Text requests stream through a local endpoint using GPT-6 Luna with no reasoning
or application tools. Development can use Codex-managed ChatGPT sign-in; the API
provider is selected explicitly for API-key use and preview. A startup spinner
and sign-in dialog keep authentication separate from the conversation controls.

Received text enters a presentation buffer. A non-cyclic clock varies update
intervals, increases chunk size when the queue grows, and bounds the remaining
delay after transport completion. The displayed text retains its original
Markdown and Unicode content. The agent orb stays below the latest reply and
moves smoothly when its height changes.

A send spacer lifts the user's new message to the top even before the transcript
fills the screen. Reply growth and reader scrolling consume that space without
restoring it. Streaming does not scroll the viewport; returning to the latest
content is an explicit action. Page-level typing and editing shortcuts open the
composer outside active voice calls, editable controls, and modal dialogs.

Quiet Zen sound cues accompany meaningful interactions. Agent typing selects
some visible updates with small variations in timing, gain, and playback rate.
The preference is persistent and can be muted; no audio or conversation history
is saved by the application.

## Dictating a text message

The microphone control records locally and reuses the fixed waveform for input
feedback. Stop transcribes with GPT Transcribe and appends the result to the
existing draft; Check submits the same merged text through the text conversation.
Cancel discards the recording and preserves the draft. Calls and dictation are
mutually exclusive, and the call control disappears once text messages exist.

Only Stop or Check uploads audio. Recordings are bounded to five minutes and
25,000,000 bytes, and resources close on completion, cancellation and failure.
Transcription uses the server's API key independently of Codex sign-in. Errors
leave the draft intact and remain available for dismissal or retry.

## Keeping signaling separate from audio

The browser requests microphone permission and creates a WebRTC connection. A
small Node.js endpoint, mounted through Vite for local development and preview,
exchanges the connection offer with OpenAI using the official TypeScript SDK.
The browser receives the session identifier and SDP answer. Credentials and
model configuration remain on the server.

Audio travels over the negotiated WebRTC connection rather than through the
application server. GPT-Live-1 manages the spoken conversation, with GPT-6 Luna
configured as its Responses backend using no reasoning effort. Tool calls are
disabled, and the other model settings use the API defaults.

## Treating playback as its own responsibility

Receiving audio packets does not establish that a browser is playing them. The
playback investigation used a local WebRTC connection and synthetic audio to
check that distinction without spending API credits.

A native audio element consumes the model's remote stream. A separate Web Audio
analyser measures that stream for the orb, while another analyser observes the
microphone for the waveform. Microphone audio is never routed to the speakers.
The waveform follows speech quickly and returns gradually to its idle state.

Session lifecycle code owns these resources outside the React components. It
handles connection setup, cancellation, playback failures, and disconnection.
Ending a call silences both sides and waits for the server's close acknowledgment
before releasing the connection, with a timeout for incomplete finalization.
Unexpected player errors or interruptions also release the microphone rather
than leaving a silent call connected.

## A local prototype with explicit limits

Dot has no application user database, saved conversations, or recordings.
Local text development uses the user's Codex-managed ChatGPT account. Interface
sound preferences are stored locally; transcripts remain in browser memory. It does not request OpenAI session storage. The signaling and transcription endpoints
accept matching localhost origins; publishing a service for other users would
require authentication and request controls around the paid API.

Focused unit tests cover the session contract, input/output separation,
cancellation, playback failure, cleanup, waveform behavior, deferred dictation
uploads, recording limits, transcript insertion and sending, authentication,
paced text, spacer consumption, keyboard editing, and sound selection. Local Chrome
verification confirmed playback with synthetic audio. A complete conversation
against OpenAI and real microphone dictation remain separate live validation steps.
