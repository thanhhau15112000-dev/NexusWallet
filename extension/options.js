const form = document.querySelector('#settings-form');
const originInput = document.querySelector('#origin');
const status = document.querySelector('#status');
const ORIGIN_KEY = 'dashboardOrigin';

function showMessage(message, tone = '') {
  status.textContent = message;
  status.dataset.tone = tone;
}

function parseOrigin(value) {
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase());
  if (
    (url.protocol !== 'https:' && !isLocalHttp) ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use an HTTPS origin or a localhost HTTP origin, without a path.');
  }
  return url.origin;
}

function normaliseStoredOrigin(value) {
  try {
    return parseOrigin(value);
  } catch {
    return null;
  }
}

void chrome.storage.local.get(ORIGIN_KEY).then(({ [ORIGIN_KEY]: origin }) => {
  if (typeof origin === 'string') originInput.value = origin;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const origin = parseOrigin(originInput.value.trim());
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      showMessage('Chrome did not grant access to this host.', 'error');
      return;
    }
    const { [ORIGIN_KEY]: previousValue } = await chrome.storage.local.get(ORIGIN_KEY);
    await chrome.storage.local.set({ [ORIGIN_KEY]: origin });
    const previousOrigin = normaliseStoredOrigin(previousValue ?? '');
    if (previousOrigin && previousOrigin !== origin) {
      await chrome.permissions.remove({ origins: [`${previousOrigin}/*`] });
    }
    originInput.value = origin;
    showMessage('Saved. The extension can check this backend and open its dashboard.', 'success');
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Could not save this origin.', 'error');
  }
});
