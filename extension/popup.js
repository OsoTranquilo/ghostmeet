const statusEl = document.getElementById('status');

function show(text) {
  statusEl.textContent = text;
}

// Send a message to the background WITHOUT awaiting the response. The popup
// closes the moment the side panel opens (focus loss), and any pending await
// would be cancelled — but the message itself is already queued and the service
// worker keeps processing it.
function notifyBackground(action, tabId) {
  const msg = { action };
  if (tabId != null) msg.tabId = tabId;
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function activeTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const tabId = await activeTabId();
  // 1. Start the capture FIRST (fire-and-forget): the service worker wakes up,
  //    calls the daemon /start and stores the active session id.
  notifyBackground('start_capture', tabId);
  // 2. Open the panel with the fresh click gesture. Force-enable the tab first:
  //    per-tab disabled overrides from a previous capture can persist, and
  //    open() would fail with "No active side panel for tabId".
  if (chrome.sidePanel && tabId != null) {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: true });
    } catch {
      // ignore — open() below will surface real problems
    }
    chrome.sidePanel.open({ tabId }).catch((e) => show(`⚠ panel: ${e.message}`));
  }
});

document.getElementById('stopBtn').addEventListener('click', () => {
  show('■ stopped — finishing transcription...');
  // 1. Stop the daemon directly: the request reaches 127.0.0.1 even if the
  //    popup dies right after (the daemon processes it server-side).
  fetch('http://127.0.0.1:8899/stop').catch(() => {});
  // 2. Clean up state in the background (clears storage, notifies the panel).
  notifyBackground('stop_capture');
});
