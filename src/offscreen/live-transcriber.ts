const GROQ_CHUNK_DURATION_MS = 10_000;
const MLX_SMALL_CHUNK_DURATION_MS = 2_500;
const MLX_TINY_CHUNK_DURATION_MS = 1_500;

let mediaStream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let recorder: MediaRecorder | undefined;
let stopTimer: number | undefined;
let activeTabId: number | undefined;
let session = 0;
let lastText = '';
let uploadRunning = false;
let pendingChunk: { blob: Blob; tabId: number; session: number } | undefined;
let recognitionConfig: RecognitionConfig | undefined;

type RecognitionConfig = {
  groqApiKey: string;
  sourceLanguage: string;
  speechRecognitionProvider: 'groq' | 'mlx';
  mlxWhisperEndpoint: string;
  mlxWhisperModel: string;
};

type StartMessage = { type: 'SUB3_START_TRANSCRIPTION'; streamId: string; tabId: number; config: RecognitionConfig };

function preferredMimeType(): string {
  return ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function chunkDuration(): number {
  if (recognitionConfig?.speechRecognitionProvider !== 'mlx') return GROQ_CHUNK_DURATION_MS;
  return recognitionConfig.mlxWhisperModel.includes('tiny')
    ? MLX_TINY_CHUNK_DURATION_MS
    : MLX_SMALL_CHUNK_DURATION_MS;
}

async function transcribe(blob: Blob, tabId: number, currentSession: number): Promise<void> {
  if (blob.size < 512 || currentSession !== session) return;
  const config = recognitionConfig;
  if (!config) throw new Error('Налаштування розпізнавання не передано');
  const provider = config.speechRecognitionProvider;
  const apiKey = config.groqApiKey.trim();
  if (provider === 'groq' && !apiKey) throw new Error('Додайте Groq API key у вкладці Translation');

  const language = config.sourceLanguage.trim().toLowerCase().split('-')[0];
  if (provider === 'mlx') {
    const endpoint = config.mlxWhisperEndpoint.trim()
      ? config.mlxWhisperEndpoint.trim().replace(/\/$/, '')
      : 'http://127.0.0.1:5051';
    const model = config.mlxWhisperModel.trim()
      ? config.mlxWhisperModel.trim()
      : 'mlx-community/whisper-small-mlx';
    const url = new URL(`${endpoint}/transcribe`);
    if (language && language !== 'auto') url.searchParams.set('language', language);
    url.searchParams.set('model', model);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
    if (!response.ok) throw new Error(`MLX Whisper повернув ${response.status}`);
    const data = await response.json() as { text?: string; language?: string };
    await publishTranscript(typeof data.text === 'string' ? data.text.trim() : '', tabId, currentSession, data.language);
    return;
  }

  const form = new FormData();
  form.append('file', blob, 'sub3-live.webm');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language && language !== 'auto') form.append('language', language.split('-')[0]);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!response.ok) throw new Error(`Groq Speech повернув ${response.status}`);
  const data = await response.json() as { text?: string; language?: string };
  await publishTranscript(typeof data.text === 'string' ? data.text.trim() : '', tabId, currentSession, data.language);
}

async function publishTranscript(text: string, tabId: number, currentSession: number, sourceLanguage?: string): Promise<void> {
  if (currentSession !== session) return;
  if (!text) {
    lastText = '';
    await chrome.runtime.sendMessage({ type: 'SUB3_LIVE_TRANSCRIPT', tabId, text: '' });
    return;
  }
  if (text === lastText) return;
  lastText = text;
  await chrome.runtime.sendMessage({ type: 'SUB3_LIVE_TRANSCRIPT', tabId, text, sourceLanguage });
}

function queueTranscription(blob: Blob, tabId: number, currentSession: number): void {
  // Keep only the newest waiting chunk. If decoding becomes slower than playback,
  // dropping stale audio is better than letting live subtitles fall further behind.
  pendingChunk = { blob, tabId, session: currentSession };
  if (uploadRunning) return;
  uploadRunning = true;
  void (async () => {
    while (pendingChunk) {
      const job = pendingChunk;
      pendingChunk = undefined;
      try {
        await transcribe(job.blob, job.tabId, job.session);
      } catch (error) {
        await chrome.runtime.sendMessage({
          type: 'SUB3_TRANSCRIPTION_ERROR',
          tabId: job.tabId,
          error: error instanceof Error ? error.message : 'Розпізнавання недоступне'
        });
      }
    }
  })().finally(() => { uploadRunning = false; });
}

function recordNextChunk(currentSession: number): void {
  if (!mediaStream || currentSession !== session) return;
  const mimeType = preferredMimeType();
  const chunks: Blob[] = [];
  recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => {
    if (!chunks.length || activeTabId === undefined) return;
    const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || 'audio/webm' });
    const tabId = activeTabId;
    queueTranscription(blob, tabId, currentSession);
    recordNextChunk(currentSession);
  });
  recorder.start();
  stopTimer = window.setTimeout(() => {
    if (recorder?.state === 'recording' && currentSession === session) recorder.stop();
  }, chunkDuration());
}

async function stopCapture(notify = true): Promise<void> {
  session += 1;
  if (stopTimer) window.clearTimeout(stopTimer);
  stopTimer = undefined;
  if (recorder?.state === 'recording') recorder.stop();
  recorder = undefined;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = undefined;
  await audioContext?.close().catch(() => undefined);
  audioContext = undefined;
  const tabId = activeTabId;
  activeTabId = undefined;
  recognitionConfig = undefined;
  pendingChunk = undefined;
  lastText = '';
  if (notify && tabId !== undefined) await chrome.runtime.sendMessage({ type: 'SUB3_TRANSCRIPTION_STOPPED', tabId });
}

async function startCapture(message: StartMessage): Promise<void> {
  await stopCapture(false);
  const currentSession = session;
  activeTabId = message.tabId;
  recognitionConfig = message.config;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Chrome-specific constraints consume the stream id created by tabCapture.
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
    } as MediaTrackConstraints,
    video: false
  });

  // Capturing a tab otherwise mutes it. Route a copy back to the speakers.
  audioContext = new AudioContext();
  audioContext.createMediaStreamSource(mediaStream).connect(audioContext.destination);
  mediaStream.getAudioTracks()[0]?.addEventListener('ended', () => void stopCapture());
  recordNextChunk(currentSession);
  await chrome.runtime.sendMessage({ type: 'SUB3_TRANSCRIPTION_STARTED', tabId: message.tabId });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SUB3_START_TRANSCRIPTION') {
    void startCapture(message as StartMessage)
      .then(() => sendResponse({ ok: true }))
      .catch(async (error: unknown) => {
        await stopCapture(false);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Не вдалося захопити звук вкладки' });
      });
    return true;
  }
  if (message?.type === 'SUB3_STOP_TRANSCRIPTION') {
    void stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
  return undefined;
});
