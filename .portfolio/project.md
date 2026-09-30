---
slug: friend
portfolioIndex: 8
name: cekrauseee/friend
repositoryUrl: https://github.com/cekrauseee/friend
description: >-
  A minimal voice companion with separate visual feedback for listening and
  speaking.
metaDescription: >-
  Friend explores voice conversation with GPT-Live-1, WebRTC, a reactive pixel
  orb, and a small server-side boundary for session creation.
summary: >-
  Friend starts with a small interaction: begin a call, speak naturally, and
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

Friend is a browser-based voice experiment centered on a pixel orb and a single
call control. Starting a call reveals a fixed waveform for the microphone. The
orb responds to the model's audio, keeping the two sides of the conversation
visually distinct without introducing a transcript or a chat layout.

The interface uses neutral colors and solid controls. The call button turns red
when it ends or cancels a session. Normal operation has no visible copy;
accessible labels and contextual errors explain actions and failures when needed.
The orb adapts the Orbkit SHDR-14 shader, and the waveform uses the base renderer
from ElevenLabs UI with centered bars and a gradual release into silence.

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

Friend currently has no accounts, tools, saved conversations, or application
recordings. It does not request OpenAI session storage. The signaling endpoint
accepts matching localhost origins; publishing a service for other users would
require authentication and request controls around the paid API.

Focused unit tests cover the session contract, input/output separation,
cancellation, playback failure, cleanup, and waveform behavior. Local Chrome
verification confirmed playback with synthetic audio. A complete conversation
against OpenAI remains a separate live validation step.
