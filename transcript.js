(function(){
  const payload = window.__sf_payload || { items: [], title: 'Chat Transcript' };
  const titleEl = document.getElementById('title');
  titleEl.textContent = (payload.title || 'Chat Transcript') + ' (combined)';
  const list = document.getElementById('list');
  const frag = document.createDocumentFragment();
  (payload.items || []).forEach((html) => {
    const li = document.createElement('li');
    li.innerHTML = html;
    frag.appendChild(li);
  });
  list.appendChild(frag);
})();


