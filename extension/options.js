const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['server', 'token']).then(({ server, token }) => {
  $('server').value = server || 'http://localhost:3005';
  $('token').value = token || '';
});
$('save').onclick = async () => {
  const server = $('server').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  const msg = $('msg');
  msg.textContent = 'Testing…'; msg.style.color = '';
  try {
    const r = await fetch(`${server}/api/applications`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) throw new Error('Token rejected');
    if (!r.ok) throw new Error(`Server returned ${r.status}`);
    await chrome.storage.local.set({ server, token });
    msg.textContent = '✓ Connected'; msg.style.color = 'var(--ok)';
  } catch (e) {
    msg.textContent = `✕ ${e.message === 'Failed to fetch' ? 'Can\'t reach server. Is JobTrack running?' : e.message}`; msg.style.color = 'var(--danger)';
  }
};
