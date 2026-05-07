const serverStatusEl = document.getElementById('server-status');
const serviceStatusEl = document.getElementById('service-status');
const hintEl = document.getElementById('hint');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const wakeBtn = document.getElementById('wake-btn');
const spinner = document.getElementById('spinner');

let polling = null;

async function fetchStatus() {
  const r = await fetch('/gateway-api/status', { cache: 'no-store' });
  if (!r.ok) throw new Error('Status request failed');
  return r.json();
}

function paintStatus(data) {
  titleEl.textContent = `${data.serviceName} Gateway`;
  subtitleEl.textContent = data.serviceUp
    ? 'Service is up. Opening now...'
    : 'Service is offline. Wake server to continue.';

  serverStatusEl.textContent = data.server.up ? 'ONLINE' : 'OFFLINE';
  serverStatusEl.className = data.server.up ? 'ok' : 'bad';
  serviceStatusEl.textContent = data.service.up ? 'READY' : 'DOWN';
  serviceStatusEl.className = data.service.up ? 'ok' : 'bad';
}

function setLoading(isLoading) {
  spinner.classList.toggle('hidden', !isLoading);
  wakeBtn.disabled = isLoading;
}

async function refreshAndMaybeOpen() {
  const status = await fetchStatus();
  paintStatus(status);
  if (status.serviceUp) {
    window.location.reload();
    return true;
  }
  return false;
}

async function wakeFlow() {
  setLoading(true);
  hintEl.textContent = 'Sending Wake-on-LAN packet...';

  try {
    const r = await fetch('/gateway-api/wake', { method: 'POST' });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      throw new Error(data.error || 'Wake failed');
    }

    hintEl.textContent = data.message || 'Server waking up...';

    if (polling) clearInterval(polling);
    polling = setInterval(async () => {
      try {
        const opened = await refreshAndMaybeOpen();
        if (opened && polling) clearInterval(polling);
      } catch (_err) {
      }
    }, 2000);
  } catch (err) {
    hintEl.textContent = `Error: ${err.message}`;
    setLoading(false);
  }
}

wakeBtn.addEventListener('click', wakeFlow);

(async () => {
  try {
    const opened = await refreshAndMaybeOpen();
    if (opened) return;
  } catch (err) {
    hintEl.textContent = `Error: ${err.message}`;
  }
})();
