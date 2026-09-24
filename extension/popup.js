const status = document.querySelector('#status');
const details = document.querySelector('#details');
const openButton = document.querySelector('#open');
const settingsButton = document.querySelector('#settings');

let dashboardOrigin = null;

function showMessage(message, tone = '') {
  status.textContent = message;
  status.dataset.tone = tone;
}

chrome.runtime.sendMessage({ type: 'CHECK_BACKEND' }, (result) => {
  if (chrome.runtime.lastError) {
    showMessage(chrome.runtime.lastError.message, 'error');
    return;
  }
  if (!result?.ok) {
    showMessage(result?.message ?? 'Could not check the backend.', 'error');
    return;
  }

  dashboardOrigin = result.origin;
  showMessage('Backend is reachable on Solana Devnet.', 'success');
  details.hidden = false;
  details.textContent = `${result.agentId} · ${result.origin}`;
  openButton.disabled = false;
});

openButton.addEventListener('click', () => {
  if (dashboardOrigin) void chrome.tabs.create({ url: dashboardOrigin });
});

settingsButton.addEventListener('click', () => void chrome.runtime.openOptionsPage());
