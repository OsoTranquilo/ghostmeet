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

// Open the side panel with retries: a previous capture may have left this tab
// disabled per-tab (Chrome persists those overrides), and the background's
// restorePanel() runs in parallel — so try a few times before giving up, and
// fall back to opening on the whole window.
async function openPanelWithRetry(tabId, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: true }).catch(() => {});
      await chrome.sidePanel.open({ tabId });
      return true;
    } catch (e) {
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 600)); // let the background restore
      } else {
        // Last resort: open on the window's active tab.
        try {
          const win = await chrome.windows.getCurrent();
          await chrome.sidePanel.open({ windowId: win.id });
          return true;
        } catch (e2) {
          show(`⚠ panel: ${e2.message}`);
        }
      }
    }
  }
  return false;
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const tabId = await activeTabId();
  // 1. Start the capture FIRST (fire-and-forget): the service worker wakes up,
  //    calls the daemon /start, clears stuck panel overrides and stores the
  //    active session id.
  notifyBackground('start_capture', tabId);
  // 2. Open the panel with the fresh click gesture, retrying until the
  //    background has re-enabled the tab.
  if (chrome.sidePanel && tabId != null) {
    await openPanelWithRetry(tabId);
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

document.getElementById('openPanelBtn').addEventListener('click', async () => {
  const tabId = await activeTabId();
  if (chrome.sidePanel && tabId != null) {
    await openPanelWithRetry(tabId);
  } else {
    show('⚠ no active tab');
  }
});
