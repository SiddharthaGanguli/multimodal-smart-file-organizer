chrome.action.onClicked.addListener(async () => {
  // A full extension tab keeps long uploads alive; a popup closes on focus loss.
  const url = chrome.runtime.getURL("app.html");
  // Query our own extension contexts without requesting browser-history access.
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (contexts.length) {
    await chrome.tabs.update(contexts[0].tabId, { active: true });
    await chrome.windows.update(contexts[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
