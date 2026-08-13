// Drives capture. A Manifest V3 service worker cannot call chrome.tabCapture.capture()
// (it is foreground only) and has no MediaRecorder, so it hands a stream id to an
// offscreen document and lets that do the recording.
import { newSessionId } from './shared.js';

const BACKEND = '127.0.0.1:8877';
const CAPTURE_DAEMON = '127.0.0.1:8899';
const OFFSCREEN_URL = 'offscreen.html';

let active = null;

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Records tab audio so it can be transcribed on this machine.',
  });
}

async function closeOffscreen() {
  if (await offscreenExists()) await chrome.offscreen.closeDocument();
}

// --- capture daemon bridge (mic + system audio, no terminal needed) ---

// Starts capture through the local daemon. Returns null when the daemon is not
// running (caller falls back to the classic tab capture); returns the daemon's
// response otherwise.
async function daemonStart(sessionId, language) {
  try {
    const lang = encodeURIComponent(language || 'es');
    const resp = await fetch(
      `http://${CAPTURE_DAEMON}/start?session=${encodeURIComponent(sessionId)}&lang=${lang}`,
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null; // daemon not running
  }
}

// Stops capture through the local daemon. Returns null when the daemon is not
// reachable (caller falls back to the classic offscreen stop).
async function daemonStop() {
  try {
    const resp = await fetch(`http://${CAPTURE_DAEMON}/stop`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function startCapture() {
  if (active) {
    return { ok: false, error: 'already capturing', sessionId: active.sessionId };
  }

  const { language = '' } = await chrome.storage.local.get('language');
  const sessionId = newSessionId();

  // Prefer the local capture daemon: it records mic + system audio (both sides
  // of the call), which the tab-capture fallback below cannot do.
  const daemon = await daemonStart(sessionId, language);
  if (daemon) {
    if (!daemon.ok) {
      return { ok: false, error: daemon.error || 'capture daemon refused to start', sessionId };
    }
    active = { sessionId, daemon: true };
    await chrome.storage.local.set({ activeSessionId: sessionId });
    return { ok: true, sessionId, message: 'capture started (daemon: mic + system audio)' };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    return { ok: false, error: 'no active tab to capture' };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    return { ok: false, error: `could not capture this tab: ${error.message}` };
  }

  await ensureOffscreen();
  const started = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start',
    streamId,
    sessionId,
    language,
    backend: BACKEND,
  });

  if (!started || !started.ok) {
    await closeOffscreen();
    return { ok: false, error: started?.error || 'recorder failed to start' };
  }

  active = { sessionId, tabId: tab.id, daemon: false };
  await chrome.storage.local.set({ activeSessionId: sessionId });
  return { ok: true, sessionId, message: 'capture started' };
}

async function stopCapture() {
  if (!active) return { ok: false, error: 'not capturing' };

  const { sessionId, daemon } = active;
  active = null;

  if (daemon) {
    const result = await daemonStop();
    // Relay the backend's completion notice to the side panel so it shows the
    // same "Transcription complete" summary as the classic flow.
    if (result && result.complete) {
      chrome.runtime.sendMessage({ target: 'panel', action: 'backend_message', data: result.complete })
        .catch(() => {});
    }
    await chrome.storage.local.remove('activeSessionId');
    return { ok: true, sessionId, message: 'capture stopped (daemon)' };
  }

  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }).catch(() => {});
  await chrome.storage.local.remove('activeSessionId');
  return { ok: true, sessionId, message: 'capture stopped' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // offscreen and side panel traffic is addressed elsewhere
  if (message?.target && message.target !== 'background') return;

  (async () => {
    if (message.action === 'start_capture') {
      sendResponse(await startCapture());
    } else if (message.action === 'stop_capture') {
      sendResponse(await stopCapture());
    } else if (message.action === 'capture_finished') {
      // the backend finished its last pass, so the recorder is no longer needed
      await closeOffscreen();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: `unknown action ${message.action}` });
    }
  })();

  return true;
});
