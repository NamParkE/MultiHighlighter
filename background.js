// The toolbar icon opens either a popup or the side panel, chosen in the panel header
// or from the icon's right-click menu.
function applyViewMode(mode) {
  const side = mode !== 'popup';
  chrome.contextMenus.update('view-side', { checked: side }, () => void chrome.runtime.lastError);
  chrome.contextMenus.update('view-popup', { checked: !side }, () => void chrome.runtime.lastError);
  return Promise.all([
    chrome.action.setPopup({ popup: side ? '' : 'panel.html?view=popup' }),
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: side })
  ]);
}

function init() {
  chrome.storage.local.get({ viewMode: 'side' }, s => applyViewMode(s.viewMode));
}

// The popup setting lives only in memory, so apply the saved mode every time the worker
// starts (it is also lost when the extension is disabled and enabled again).
init();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'view-side', type: 'radio', title: '사이드 패널로 열기', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'view-popup', type: 'radio', title: '팝업으로 열기', contexts: ['action'] });
    init();
  });
});

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'view-side') chrome.storage.local.set({ viewMode: 'side' });
  if (info.menuItemId === 'view-popup') chrome.storage.local.set({ viewMode: 'popup' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.viewMode) applyViewMode(changes.viewMode.newValue);
});

// Frames: content scripts can't message each other directly, so the page's frames talk
// through here. Child frames report their counts to the top frame (frameId 0), and the
// top frame sends prev/next requests down to a specific frame.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined) return;
  const ignore = () => void chrome.runtime.lastError;
  if (msg.type === 'mwh-frame-report' && sender.frameId) {
    chrome.tabs.sendMessage(tabId, { ...msg, frameId: sender.frameId }, { frameId: 0 }, ignore);
  } else if (msg.type === 'mwh-to-frame') {
    chrome.tabs.sendMessage(tabId, msg.payload, { frameId: msg.frameId }, res => {
      ignore();
      sendResponse(res);
    });
    return true;
  } else if (msg.type === 'mwh-to-frames') {
    chrome.tabs.sendMessage(tabId, msg.payload, ignore);
  }
});

// Side panel → popup: the panel asks for the popup and closes itself; the popup opens
// as soon as its port disconnects. Opening it while the panel is still closing fails,
// because the closing panel takes focus away from the popup.
function openPopup(windowId, retries) {
  if (!chrome.action.openPopup) return;
  chrome.action.openPopup({ windowId }).catch(() => {
    if (retries > 0) setTimeout(() => openPopup(windowId, retries - 1), 60);
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith('popup-on-close:')) return;
  const windowId = Number(port.name.split(':')[1]);
  chrome.storage.local.set({ viewMode: 'popup' });
  port.postMessage('ready');
  port.onDisconnect.addListener(() => {
    applyViewMode('popup').then(() => openPopup(windowId, 5));
  });
});
