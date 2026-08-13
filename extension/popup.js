const statusEl = document.getElementById('status');

function show(text) {
  statusEl.textContent = text;
}

async function send(action) {
  const response = await chrome.runtime.sendMessage({ action });
  if (!response) {
    show('no response from the extension background');
    return;
  }

  if (!response.ok) {
    show(`⚠ ${response.error}`);
    return;
  }

  if (action === 'start_capture') {
    show(`● recording — ${response.sessionId}`);
    chrome.runtime.sendMessage({
      target: 'panel',
      action: 'transcript_start',
      sessionId: response.sessionId,
    }).catch(() => {});
    if (chrome.sidePanel) {
      const window = await chrome.windows.getCurrent();
      chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
    }
  } else if (action === 'stop_capture') {
    show('■ stopped — finishing transcription...');
  }
}

// Redundant safety net: stop the capture daemon directly from the popup, in
// addition to the background service worker doing it. If the service worker was
// asleep (MV3 kills idle workers), this still reaches the daemon.
async function stopDaemonDirectly() {
  try {
    const resp = await fetch('http://127.0.0.1:8899/stop');
    if (resp.ok) return await resp.json();
  } catch {
    // daemon not running — nothing to stop
  }
  return null;
}

document.getElementById('startBtn').addEventListener('click', () => send('start_capture'));
document.getElementById('stopBtn').addEventListener('click', async () => {
  await stopDaemonDirectly();
  await send('stop_capture');
});
