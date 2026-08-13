import { formatClock, renderSummary } from './shared.js';

const BACKEND_URL = '127.0.0.1:8877';

let ws = null;
let segmentCount = 0;
let startTime = null;
let durationTimer = null;
let heartbeatTimer = null;
// the session the panel is showing — outlives the capture so Summarize still works
// after Stop, when activeSessionId has already been cleared
let shownSessionId = null;

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const emptyStateEl = document.getElementById('empty-state');
const segmentCountEl = document.getElementById('segment-count');
const durationEl = document.getElementById('duration');
const languageEl = document.getElementById('language');
const btnClear = document.getElementById('btn-clear');
const btnSummarize = document.getElementById('btn-summarize');

// --- helpers ---

function setStatus(state, label) {
  statusEl.textContent = label || state;
  statusEl.className = `status ${state}`;
}

function addSegment(seg, { highlight = true } = {}) {
  emptyStateEl.classList.add('hidden');

  const div = document.createElement('div');
  div.className = highlight ? 'segment new' : 'segment';

  const timeSpan = document.createElement('div');
  timeSpan.className = 'time';
  timeSpan.textContent = `${formatClock(seg.start)} → ${formatClock(seg.end)}`;
  if (seg.speaker) timeSpan.textContent += `  ${seg.speaker}`;

  const textSpan = document.createElement('div');
  textSpan.className = 'text';
  textSpan.textContent = seg.text;

  div.appendChild(timeSpan);
  div.appendChild(textSpan);
  transcriptEl.appendChild(div);

  if (highlight) setTimeout(() => div.classList.remove('new'), 2000);
  scrollToBottom();

  segmentCount++;
  segmentCountEl.textContent = `${segmentCount} segment${segmentCount !== 1 ? 's' : ''}`;
}

function scrollToBottom() {
  const container = document.getElementById('transcript-container');
  container.scrollTop = container.scrollHeight;
}

function clearTranscript() {
  transcriptEl.innerHTML = '';
  segmentCount = 0;
  segmentCountEl.textContent = '0 segments';
  emptyStateEl.classList.remove('hidden');
}

function note(text) {
  const div = document.createElement('div');
  div.className = 'summary-loading';
  div.textContent = text;
  transcriptEl.appendChild(div);
  scrollToBottom();
  return div;
}

function getActiveSessionId() {
  return chrome.storage.local.get('activeSessionId').then((r) => r.activeSessionId || null);
}

// --- duration timer ---

function startDurationTimer() {
  startTime = Date.now();
  durationTimer = setInterval(() => {
    durationEl.textContent = formatClock((Date.now() - startTime) / 1000);
  }, 1000);
}

function stopDurationTimer() {
  if (durationTimer) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
}

// --- daemon heartbeat ---
// While the panel is showing a live session it pings the capture daemon every
// 30s. The daemon auto-stops if it hears nothing for HEARTBEAT_TIMEOUT, so a
// dead browser never leaves the mic recording, but a long meeting with the
// panel open keeps the capture alive.

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    fetch('http://127.0.0.1:8899/ping').catch(() => {});
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// --- transcript history ---

async function loadHistory(sessionId) {
  // Opening the panel mid-meeting used to show nothing until the next segment arrived.
  try {
    const resp = await fetch(`http://${BACKEND_URL}/api/sessions/${sessionId}/transcript`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const seg of data.segments || []) addSegment(seg, { highlight: false });
  } catch {
    // backend not up yet; live updates will still work once it is
  }
}

// --- WebSocket connection ---

async function connectTranscript(sessionId) {
  if (ws) ws.close();

  shownSessionId = sessionId;
  setStatus('connecting', 'connecting...');
  clearTranscript();

  // Don't show a ghost "live" timer for sessions that already finished (e.g.
  // after the browser was closed mid-capture): check the real status first.
  try {
    const resp = await fetch(`http://${BACKEND_URL}/api/sessions/${sessionId}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status && data.status !== 'streaming' && data.status !== 'transcribing') {
        await loadHistory(sessionId);
        stopHeartbeat();
        setStatus('disconnected', 'finished');
        note(`✅ Transcription complete — ${data.transcript_segments ?? 0} segments, ${formatClock(data.duration_sec ?? 0)}`);
        return;
      }
    }
  } catch {
    // backend not up yet; live updates will still work once it is
  }

  await loadHistory(sessionId);

  ws = new WebSocket(`ws://${BACKEND_URL}/ws/transcript/${sessionId}`);

  ws.onopen = () => {
    setStatus('connected', `live — ${sessionId}`);
    startDurationTimer();
    startHeartbeat();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'transcript' && data.segments) {
        data.segments.forEach((seg) => addSegment(seg));
      }
    } catch (e) {
      console.error('Failed to parse transcript message:', e);
    }
  };

  ws.onclose = () => {
    setStatus('disconnected', 'disconnected');
    stopDurationTimer();
    stopHeartbeat();
  };

  ws.onerror = () => {
    setStatus('disconnected', 'connection error');
    stopDurationTimer();
    stopHeartbeat();
  };
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  stopDurationTimer();
  stopHeartbeat();
}

// --- messages from the popup, background and offscreen document ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target && message.target !== 'panel') return;

  if (message.action === 'transcript_start' && message.sessionId) {
    connectTranscript(message.sessionId);
  } else if (message.action === 'transcript_stop') {
    disconnect();
  } else if (message.action === 'backend_message' && message.data?.type === 'complete') {
    const { segment_count: count, duration_sec: duration } = message.data;
    setStatus('disconnected', 'finished');
    note(`✅ Transcription complete — ${count} segments, ${formatClock(duration)}`);
    stopDurationTimer();
    stopHeartbeat();
  }
  sendResponse({ ok: true });
  return true;
});

// --- language ---

chrome.storage.local.get('language').then(({ language }) => {
  if (language) languageEl.value = language;
});

languageEl.addEventListener('change', () => {
  // applies to the next session — Whisper is told the language when capture starts
  chrome.storage.local.set({ language: languageEl.value });
});

// --- summarize ---

btnSummarize.addEventListener('click', async () => {
  const sessionId = shownSessionId || (await getActiveSessionId());
  if (!sessionId) {
    note('No session to summarize yet — start a capture first.');
    return;
  }

  btnSummarize.disabled = true;
  btnSummarize.textContent = '⏳ Generating...';
  const loading = note('🤖 Generating summary with Claude...');

  try {
    const resp = await fetch(
      `http://${BACKEND_URL}/api/sessions/${sessionId}/summarize`,
      { method: 'POST' },
    );
    const data = await resp.json();
    loading.remove();

    if (resp.ok && data.status === 'done' && data.content) {
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'summary-block';
      summaryDiv.innerHTML = renderSummary(data.content);
      transcriptEl.appendChild(summaryDiv);
      scrollToBottom();
    } else {
      note(`❌ ${data.error || data.detail || 'Summary generation failed'}`);
    }
  } catch (e) {
    loading.remove();
    note(`❌ Failed to connect: ${e.message}`);
  } finally {
    btnSummarize.disabled = false;
    btnSummarize.textContent = '📋 Summarize';
  }
});

btnClear.addEventListener('click', clearTranscript);

// --- on load: reattach to whatever is running ---

chrome.storage.local.get('activeSessionId').then(({ activeSessionId }) => {
  if (activeSessionId) connectTranscript(activeSessionId);
});
