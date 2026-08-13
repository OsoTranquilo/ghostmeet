// Drives capture. A Manifest V3 service worker cannot call chrome.tabCapture.capture()
// (it is foreground only) and has no MediaRecorder, so it hands a stream id to an
// offscreen document and lets that do the recording.
import { newSessionId } from './shared.js';

const BACKEND = '127.0.0.1:8877';
const CAPTURE_DAEMON = '127.0.0.1:8899';
const OFFSCREEN_URL = 'offscreen.html';
const ACTIVE_KEY = 'activeCapture';
const HEARTBEAT_ALARM = 'ghostmeet-heartbeat'; // { sessionId, daemon, tabId }

// Mirrored in chrome.storage.local so the capture survives service-worker restarts.
let active = null;

// --- state persistence (MV3 kills idle service workers; never trust memory) ---

async function restoreActive() {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  active = r[ACTIVE_KEY] || null;
  return active;
}

async function setActive(value) {
  active = value;
  await chrome.storage.local.set({ [ACTIVE_KEY]: value });
}

async function clearActive() {
  active = null;
  await chrome.storage.local.remove(ACTIVE_KEY);
}

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

// Stops capture through the local daemon. Retries a couple of times: the daemon
// can be mid-transcription and slow to answer. Returns null when unreachable.
async function daemonStop() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(`http://${CAPTURE_DAEMON}/stop`, { signal: AbortSignal.timeout(100000) });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// --- side panel scoping ---
// The side panel normally shows on every tab of the window. While capturing,
// restrict it to the tab that started the capture, so it never leaks into a
// screen share of another tab.

async function restrictPanelToTab(tabId) {
  if (tabId == null) return;
  try {
    await chrome.sidePanel.setOptions({ enabled: false }); // all tabs
    await chrome.sidePanel.setOptions({ tabId, enabled: true }); // capture tab only
  } catch (e) {
    console.error('restrictPanelToTab failed', e);
  }
}

async function restorePanel() {
  try {
    await chrome.sidePanel.setOptions({ enabled: true });
  } catch {
    // ignore
  }
}

async function startCapture(tabId) {
  await restoreActive();
  if (active) {
    return { ok: false, error: 'already capturing', sessionId: active.sessionId };
  }

  const { language = '' } = await chrome.storage.local.get('language');
  const sessionId = newSessionId();

  // The popup knows its own window, so it passes the tab id explicitly — the
  // service worker's "currentWindow" can resolve to the wrong window otherwise.
  let tab = null;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }

  // Prefer the local capture daemon: it records mic + system audio (both sides
  // of the call), which the tab-capture fallback below cannot do.
  const daemon = await daemonStart(sessionId, language);
  if (daemon) {
    if (!daemon.ok) {
      return { ok: false, error: daemon.error || 'capture daemon refused to start', sessionId };
    }
    await setActive({ sessionId, daemon: true, tabId: tab?.id ?? null });
    await chrome.storage.local.set({ activeSessionId: sessionId });
    await restrictPanelToTab(tab?.id);
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
    return { ok: true, sessionId, message: 'capture started (daemon: mic + system audio)' };
  }

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

  await setActive({ sessionId, tabId: tab.id, daemon: false });
  await chrome.storage.local.set({ activeSessionId: sessionId });
  await restrictPanelToTab(tab.id);
  return { ok: true, sessionId, message: 'capture started' };
}

async function stopCapture() {
  await restoreActive();
  if (!active) return { ok: false, error: 'not capturing' };

  const { sessionId, daemon } = active;
  await clearActive();
  await chrome.storage.local.remove('activeSessionId');
  await restorePanel();
  chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => {});

  if (daemon) {
    const result = await daemonStop();
    // Relay the backend's completion notice to the side panel so it shows the
    // same "Transcription complete" summary as the classic flow.
    if (result && result.complete) {
      chrome.runtime.sendMessage({ target: 'panel', action: 'backend_message', data: result.complete })
        .catch(() => {});
    }
    // Always reset the panel UI, even if the completion relay failed.
    chrome.runtime.sendMessage({ target: 'panel', action: 'transcript_stop' }).catch(() => {});
    return { ok: true, sessionId, message: 'capture stopped (daemon)' };
  }

  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'panel', action: 'transcript_stop' }).catch(() => {});
  return { ok: true, sessionId, message: 'capture stopped' };
}

// Safety net: closing the tab that started the capture stops the daemon too
// (e.g. the user ends the meeting and closes the Meet tab).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cur = await restoreActive();
  if (cur && cur.tabId === tabId) {
    await stopCapture();
  }
});

// Heartbeat while capturing: chrome.alarms wakes the service worker even when
// it is idle and even if the side panel is closed, so a long meeting keeps the
// daemon alive but a dead browser lets the daemon auto-stop.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  const cur = await restoreActive();
  if (!cur || !cur.daemon) return;
  try {
    await fetch(`http://${CAPTURE_DAEMON}/ping`);
  } catch {
    // daemon unreachable — nothing else to do
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // offscreen and side panel traffic is addressed elsewhere
  if (message?.target && message.target !== 'background') return;

  (async () => {
    if (message.action === 'start_capture') {
      sendResponse(await startCapture(message.tabId));
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

// Rehydrate state when the service worker wakes up (it is killed when idle).
restoreActive();
