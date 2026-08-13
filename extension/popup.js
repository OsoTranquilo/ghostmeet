const statusEl = document.getElementById('status');

function show(text) {
  statusEl.textContent = text;
}

async function send(action) {
  // The popup knows its own window; pass the active tab id so the background
  // restricts the side panel to the right tab (the service worker's
  // "currentWindow" can resolve to a different window otherwise).
  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch {
    tabId = undefined;
  }

  const response = await chrome.runtime.sendMessage({ action, tabId });
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
    // Open the panel on the capture tab explicitly (windowId can fail when the
    // panel is restricted per-tab). Surface errors instead of swallowing them.
    if (chrome.sidePanel) {
      if (tabId != null) {
        chrome.sidePanel.open({ tabId }).catch((e) => show(`⚠ panel: ${e.message}`));
      } else {
        const window = await chrome.windows.getCurrent();
        chrome.sidePanel.open({ windowId: window.id }).catch((e) => show(`⚠ panel: ${e.message}`));
      }
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

document.getElementById('startBtn').addEventListener('click', async () => {
  // Open the side panel IMMEDIATELY on the current tab: sidePanel.open() needs a
  // fresh user gesture, and waiting on the background round-trip (fetch to the
  // daemon) can make Chrome drop it.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (chrome.sidePanel && tab?.id != null) {
      chrome.sidePanel.open({ tabId: tab.id }).catch((e) => show(`⚠ panel: ${e.message}`));
    }
  } catch (e) {
    show(`⚠ panel: ${e.message}`);
  }
  await send('start_capture');
});
document.getElementById('stopBtn').addEventListener('click', async () => {
  await stopDaemonDirectly();
  await send('stop_capture');
});
