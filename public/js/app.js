function toast(msg, type) { const t=document.getElementById('toast'); t.textContent=msg; t.className='toast '+type; setTimeout(()=>t.className='toast',3000); }
async function addUrl() {
  const inp=document.getElementById('newUrl'); const url=inp.value.trim();
  if(!url) return;
  const r=await fetch('/api/urls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
  if(!r.ok) { const e=await r.json(); toast(e.error||'Failed','error'); return; }
  inp.value=''; location.reload();
}
async function delUrl(enc) {
  if(!confirm('Delete this URL?')) return;
  const r=await fetch('/api/urls/'+enc,{method:'DELETE'});
  if(!r.ok) { const e=await r.json(); toast(e.error||'Failed','error'); return; }
  location.reload();
}
async function editUrl(enc) {
  const current=decodeURIComponent(enc);
  const url=prompt('Edit URL:',current);
  if(!url||url===current) return;
  const r=await fetch('/api/urls/'+enc,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
  if(!r.ok) { const e=await r.json(); toast(e.error||'Failed','error'); return; }
  location.reload();
}
document.querySelectorAll('.btn-del').forEach(b=>b.addEventListener('click',()=>delUrl(b.dataset.url)));
document.querySelectorAll('.btn-edit').forEach(b=>b.addEventListener('click',()=>editUrl(b.dataset.url)));

const pollInterval = parseInt(document.getElementById('config').dataset.interval) * 1000;
setInterval(async () => {
  const r = await fetch('/api/stats');
  if (!r.ok) return;
  const s = await r.json();
  document.getElementById('last-checked').textContent = s.lastChecked;
  const badge = document.getElementById('status-badge');
  const cls = s.overallStatus === 'ALL UP' ? 'up' : s.overallStatus === 'ALL DOWN' ? 'down' : 'warning';
  badge.textContent = s.overallStatus;
  badge.className = 'status-badge status-' + cls;
  document.getElementById('stat-total').textContent = s.global.totalMins;
  document.getElementById('stat-up').textContent = s.global.upMins;
  document.getElementById('stat-down').textContent = s.global.downMins;
  document.getElementById('stat-unclear').textContent = s.global.unclearMins;
  document.getElementById('stat-uptime').textContent = s.global.uptimePct;
}, pollInterval);
