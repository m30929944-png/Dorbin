// ================================================================
// app.js - کد کامل سمت کلاینت
// ================================================================

// ======= متغیرها =======
let currentUser = null;
let socket = null;
let currentPage = 'channel';
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;
let postPage = 1;
let explorePage = 1;
let exploreTotalPages = 1;
let hasMorePosts = true;
let isLoading = false;
let pendingMedia = null;
let pendingMediaType = null;
let unreadNotifs = 0;

// ======= مقداردهی =======
async function init() {
  const saved = localStorage.getItem('yareman_user_id');
  const token = localStorage.getItem('yareman_token');
  if (saved && token) {
    try {
      const res = await fetch(`/api/user/${saved}`, { headers: { 'Authorization': 'Bearer ' + token } });
      if (res.ok) {
        currentUser = await res.json();
        currentUser.token = token;
        afterLogin();
        return;
      }
    } catch (e) {}
  }
  showRegister();
}

function afterLogin() {
  localStorage.setItem('yareman_user_id', currentUser.id);
  if (currentUser.token) localStorage.setItem('yareman_token', currentUser.token);
  document.getElementById('userName').textContent = currentUser.name;
  document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
  document.getElementById('composerAvatar').src = currentUser.avatar || defaultAvatar(currentUser.name);
  document.getElementById('scoreValue').textContent = currentUser.score || 0;
  connectSocket();
  setupNav();
  setupEvents();
  navigateTo('channel');
  setInterval(updateScore, 60000);
}

function defaultAvatar(seed) { return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed||'user')}`; }

// ======= ثبت‌نام =======
function showRegister() {
  const m = document.createElement('div');
  m.className = 'modal';
  m.id = 'regModal';
  m.style.display = 'flex';
  m.innerHTML = `
    <div class="modal-content">
      <h2 style="text-align:center;margin-bottom:12px;">👋 خوش اومدی!</h2>
      <div class="avatar-upload">
        <img id="regAvatar" src="${defaultAvatar('guest')}">
        <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
      </div>
      <input class="name-input" id="regName" placeholder="اسمت چیه؟">
      <input class="name-input" id="regPass" placeholder="رمز عبور (اختیاری)" type="password">
      <button class="btn-primary" style="width:100%;padding:10px;" onclick="register()">🚀 ورود</button>
    </div>
  `;
  document.body.appendChild(m);
  document.getElementById('regAvatarInput').onchange = function(e) {
    const reader = new FileReader();
    reader.onload = (ev) => document.getElementById('regAvatar').src = ev.target.result;
    reader.readAsDataURL(e.target.files[0]);
  };
}

async function register() {
  const name = document.getElementById('regName').value.trim();
  const pass = document.getElementById('regPass').value.trim();
  const avatar = document.getElementById('regAvatar').src;
  if (!name) return showNotification('اسمت رو بنویس!', 'error');
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, avatar, password: pass })
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      currentUser.token = data.token;
      document.getElementById('regModal').remove();
      showNotification('✅ خوش اومدی!', 'success');
      afterLogin();
    } else showNotification('خطا: ' + data.error, 'error');
  } catch (e) { showNotification('خطا در ارتباط', 'error'); }
}

function logout() {
  if (socket) socket.disconnect();
  localStorage.clear();
  location.reload();
}

// ======= سوکت =======
function connectSocket() {
  socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  socket.on('connect', () => { if (currentUser) socket.emit('join', currentUser.id); });
  socket.on('new_message', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
      const c = document.getElementById('chatMessages');
      const d = document.createElement('div');
      d.className = 'message received entering';
      d.textContent = data.message;
      c.appendChild(d);
      c.scrollTop = c.scrollHeight;
    }
    loadChatList();
    showNotification('📩 پیام جدید', 'info');
  });
  socket.on('typing', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
      const s = document.getElementById('chatStatus');
      s.textContent = data.isTyping ? 'در حال تایپ...' : (onlineUsers[currentChatUser.id] ? 'آنلاین' : 'آفلاین');
    }
  });
  socket.on('new_follower', (data) => {
    showNotification(`👤 ${data.followerName || 'کاربر'} شما را فالو کرد!`, 'success');
    updateScore();
  });
}

// ======= ناوبری =======
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.onclick = () => { document.querySelectorAll('.nav-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); navigateTo(b.dataset.page); };
  });
  document.getElementById('profileBtn').onclick = (e) => {
    e.stopPropagation();
    const m = document.getElementById('dropdownMenu');
    m.style.display = m.style.display === 'none' ? 'block' : 'none';
  };
  document.onclick = () => document.getElementById('dropdownMenu').style.display = 'none';
}

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(page + 'Page').classList.add('active');
  currentPage = page;
  switch(page) {
    case 'channel': loadChannel(); break;
    case 'assistant': loadAssistant(); break;
    case 'chat': loadChatList(); break;
    case 'explore': loadExplore(); break;
  }
}

// ======= رویدادها =======
function setupEvents() {
  document.getElementById('postImageInput').onchange = function(e) {
    const r = new FileReader();
    r.onload = (ev) => { pendingMedia = ev.target.result; pendingMediaType = 'image'; showMediaPreview(ev.target.result); };
    r.readAsDataURL(e.target.files[0]);
  };
  document.getElementById('postVideoInput').onchange = function(e) {
    const r = new FileReader();
    r.onload = (ev) => { pendingMedia = ev.target.result; pendingMediaType = 'video'; showMediaPreview(ev.target.result); };
    r.readAsDataURL(e.target.files[0]);
  };
  document.getElementById('postContent').oninput = function() {
    const c = document.getElementById('charCounter');
    const l = this.value.length;
    c.textContent = l + '/5000';
    c.className = 'char-counter' + (l > 4000 ? ' warning' : '') + (l > 4900 ? ' danger' : '');
  };
  document.getElementById('myAvatarInput').onchange = function(e) {
    const r = new FileReader();
    r.onload = (ev) => document.getElementById('myAvatarPreview').src = ev.target.result;
    r.readAsDataURL(e.target.files[0]);
  };
  document.getElementById('searchInput').oninput = debounce(handleSearch, 400);
}

// ======= توابع کمکی =======
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }

function showNotification(text, type = 'info') {
  const c = document.querySelector('.toast-container') || (() => { const x = document.createElement('div'); x.className = 'toast-container'; document.body.appendChild(x); return x; })();
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = text;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2800);
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function timeAgo(d) {
  if (!d) return '';
  const diff = (Date.now() - new Date(d + 'Z').getTime()) / 1000;
  if (diff < 60) return 'همین الان';
  if (diff < 3600) return Math.floor(diff/60) + ' دقیقه پیش';
  if (diff < 86400) return Math.floor(diff/3600) + ' ساعت پیش';
  if (diff < 172800) return 'دیروز';
  if (diff < 2592000) return Math.floor(diff/86400) + ' روز پیش';
  return new Date(d).toLocaleDateString('fa-IR');
}

function formatNumber(n) { if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(1)+'K'; return n.toString(); }

function showMediaPreview(url) {
  document.getElementById('mediaPreview').style.display = 'block';
  document.getElementById('mediaPreviewImg').src = url;
}
function clearMediaPreview() {
  document.getElementById('mediaPreview').style.display = 'none';
  document.getElementById('mediaPreviewImg').src = '';
  pendingMedia = null; pendingMediaType = null;
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function toggleNotifications() {
  const p = document.getElementById('notificationsPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}
function updateScore() {
  fetch(`/api/user/${currentUser.id}`).then(r=>r.json()).then(d => {
    currentUser.score = d.score || 0;
    document.getElementById('scoreValue').textContent = currentUser.score;
  }).catch(e=>{});
}

// ======= جستجو =======
async function handleSearch(e) {
  const q = e.target.value.trim();
  const r = document.getElementById('searchResults');
  if (q.length < 2) { r.classList.remove('active'); return; }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.length) {
      r.innerHTML = data.map(u => `<div class="dropdown-item" onclick="openProfile('${u.id}')"><i class="fas fa-${u.type==='user'?'user':'bullhorn'}"></i> ${escapeHtml(u.name)}</div>`).join('');
      r.classList.add('active');
    } else { r.innerHTML = '<div class="dropdown-item" style="color:var(--text-3)"><i class="fas fa-search"></i> نتیجه‌ای یافت نشد</div>'; r.classList.add('active'); }
  } catch(e) { r.classList.remove('active'); }
}

// ======= پست =======
async function createPost() {
  const content = document.getElementById('postContent').value.trim();
  if (!content) return showNotification('متن بنویس!', 'error');
  const btn = document.querySelector('.composer .btn-primary');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const res = await fetch('/api/post/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
      body: JSON.stringify({ userId: currentUser.id, content, mediaData: pendingMedia, mediaType: pendingMediaType })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('postContent').value = ''; clearMediaPreview();
      showNotification('✅ منتشر شد!', 'success');
      if (data.boost) updateBoost(data.boost.boostLevel);
      postPage = 1; hasMorePosts = true; loadChannel();
      updateScore();
    } else showNotification('خطا: ' + data.error, 'error');
  } catch(e) { showNotification('خطا', 'error'); }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> انتشار';
}

function updateBoost(level) {
  const b = document.getElementById('boostBadge');
  const labels = { normal:'عادی', high:'🔥 داغ', viral:'🚀 وایرال', superstar:'⭐ ستاره' };
  b.textContent = labels[level] || 'عادی';
  b.className = 'boost-badge boost-' + level;
}

async function loadChannel() {
  if (isLoading) return;
  isLoading = true;
  const c = document.getElementById('channelPosts');
  if (postPage === 1) c.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>بارگذاری...</span></div>';
  try {
    const res = await fetch(`/api/channel/${currentUser.id}/posts?page=${postPage}&limit=10`);
    const data = await res.json();
    if (postPage === 1) c.innerHTML = '';
    if (data.posts && data.posts.length) {
      c.innerHTML += data.posts.map(p => renderPost(p)).join('');
      hasMorePosts = data.posts.length >= 10;
      postPage++;
      document.getElementById('loadMoreContainer').style.display = hasMorePosts ? 'block' : 'none';
    } else if (postPage === 1) {
      c.innerHTML = '<div class="empty-state"><i class="fas fa-pen-fancy"></i><h3>هنوز پستی نداری</h3><p>اولین پستت رو بنویس!</p></div>';
    }
    const u = await fetch(`/api/user/${currentUser.id}`).then(r=>r.json());
    document.getElementById('followersCount').innerHTML = `<i class="fas fa-users"></i> ${u.followers||0}`;
    document.getElementById('postsCount').innerHTML = `<i class="fas fa-file-alt"></i> ${u.posts||0}`;
  } catch(e) { c.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>خطا</h3><button class="btn-secondary" onclick="loadChannel()">تلاش مجدد</button></div>'; }
  isLoading = false;
}
function loadMorePosts() { loadChannel(); }

function renderPost(p) {
  const name = p.channel_name || 'کاربر';
  const avatar = currentUser.avatar || defaultAvatar(name);
  return `
  <div class="post-card glass-card" data-post-id="${p.id}">
    <div class="post-head" onclick="openProfile('${currentUser.id}')">
      <img src="${avatar}"><span class="name">${escapeHtml(name)}</span><span class="time">${timeAgo(p.created_at)}</span>
    </div>
    <p class="content">${escapeHtml(p.content)}</p>
    ${p.media_url ? `<div class="post-media"><img src="${p.media_url}" loading="lazy"></div>` : ''}
    <div class="post-stats">
      <button onclick="toggleLike('${p.id}',this)"><i class="far fa-heart"></i> <span class="like-count">${formatNumber(p.likes||0)}</span></button>
      <button onclick="toggleComments('${p.id}',this)"><i class="far fa-comment"></i> <span class="comment-count">${formatNumber(p.comments||0)}</span></button>
      <button onclick="sharePost('${p.id}')"><i class="far fa-share-alt"></i></button>
      <span><i class="far fa-eye"></i> ${formatNumber(p.views||0)}</span>
    </div>
    <div class="comments-box" id="comments-${p.id}"><div id="commentsList-${p.id}"></div><div class="comment-form"><input id="commentInput-${p.id}" placeholder="کامنت..." onkeypress="if(event.key==='Enter') submitComment('${p.id}')"><button class="btn-secondary" onclick="submitComment('${p.id}')"><i class="fas fa-paper-plane"></i></button></div></div>
  </div>`;
}

async function toggleLike(id, btn) {
  try {
    const res = await fetch(`/api/post/${id}/like`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id}) });
    const d = await res.json();
    if (d.success) {
      btn.classList.toggle('liked', d.liked);
      btn.querySelector('i').className = d.liked ? 'fas fa-heart' : 'far fa-heart';
      btn.querySelector('.like-count').textContent = formatNumber(d.likes);
    }
  } catch(e) {}
}

async function toggleComments(id, btn) {
  const box = document.getElementById('comments-' + id);
  box.classList.toggle('open');
  if (box.classList.contains('open') && !box.dataset.loaded) {
    box.dataset.loaded = '1';
    try {
      const res = await fetch(`/api/post/${id}/comments`);
      const data = await res.json();
      document.getElementById('commentsList-'+id).innerHTML = data.map(c => `<div class="comment-item"><img src="${c.avatar||defaultAvatar(c.name)}"><div><b>${escapeHtml(c.name)}</b> ${escapeHtml(c.text)}</div></div>`).join('');
    } catch(e) {}
  }
}

async function submitComment(id) {
  const input = document.getElementById('commentInput-'+id);
  const text = input.value.trim();
  if (!text) return;
  try {
    const res = await fetch(`/api/post/${id}/comment`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id, text}) });
    const d = await res.json();
    if (d.success) {
      input.value = '';
      const list = document.getElementById('commentsList-'+id);
      const item = document.createElement('div');
      item.className = 'comment-item entering';
      item.innerHTML = `<img src="${d.comment.avatar||defaultAvatar(d.comment.name)}"><div><b>${escapeHtml(d.comment.name)}</b> ${escapeHtml(d.comment.text)}</div>`;
      list.prepend(item);
      const count = document.querySelector(`[data-post-id="${id}"] .comment-count`);
      if (count) count.textContent = formatNumber(parseInt(count.textContent.replace(/[^0-9]/g,'')) + 1);
    }
  } catch(e) {}
}
function sharePost(id) { navigator.clipboard.writeText(window.location.origin+'/post/'+id); showNotification('📋 کپی شد!', 'success'); }
function addHashtag() {
  const t = document.getElementById('postContent');
  const s = t.selectionStart;
  t.value = t.value.substring(0,s) + ' #' + t.value.substring(s);
  t.focus(); t.selectionStart = t.selectionEnd = s + 2;
}

// ======= دستیار =======
async function loadAssistant() {
  try {
    const res = await fetch(`/api/assistant/${currentUser.id}`);
    const d = await res.json();
    document.getElementById('statPosts').textContent = d.stats?.totalPosts || 0;
    document.getElementById('statTrainings').textContent = d.stats?.totalTrainings || 0;
    document.getElementById('statFollowers').textContent = d.stats?.followers || 0;
    document.getElementById('statEngagement').textContent = d.stats?.engagementRate || '0%';
    document.getElementById('qaList').innerHTML = d.qa?.length ? d.qa.map(q => `<div class="qa-item"><span>❓ ${escapeHtml(q.question)}</span><span>💬 ${escapeHtml(q.answer)}</span></div>`).join('') : '<div class="empty-state" style="padding:8px 0"><p style="font-size:12px;">هیچ آموزشی ثبت نشده</p></div>';
    document.getElementById('keywordList').innerHTML = d.keywords?.length ? d.keywords.map(k => `<div class="keyword-item"><span>🔑 ${escapeHtml(k.keyword)}</span><span>💬 ${escapeHtml(k.response)}</span></div>`).join('') : '<div class="empty-state" style="padding:8px 0"><p style="font-size:12px;">هیچ کلمه کلیدی ثبت نشده</p></div>';
    document.getElementById('scheduledPostsList').innerHTML = d.posts?.length ? d.posts.map(p => `<div class="qa-item"><span>📅 ${new Date(p.scheduled_time).toLocaleDateString('fa-IR')}</span><span>${escapeHtml(p.content.slice(0,40))}...</span><button class="btn-ghost" style="color:var(--danger);font-size:11px;" onclick="cancelScheduled('${p.id}')">لغو</button></div>`).join('') : '<div class="empty-state" style="padding:8px 0"><p style="font-size:12px;">پستی زمان‌بندی نشده</p></div>';
  } catch(e) { showNotification('خطا در بارگذاری دستیار', 'error'); }
}

async function trainAssistant() {
  const q = document.getElementById('questionInput').value.trim();
  const a = document.getElementById('answerInput').value.trim();
  if (!q || !a) return showNotification('سوال و جواب رو کامل کن!', 'error');
  try {
    const res = await fetch('/api/assistant/train', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id, question:q, answer:a}) });
    const d = await res.json();
    if (d.success) { showNotification('✅ دستیار یاد گرفت!', 'success'); document.getElementById('questionInput').value = ''; document.getElementById('answerInput').value = ''; if(d.boost) updateBoost(d.boost.boostLevel); loadAssistant(); updateScore(); }
  } catch(e) { showNotification('خطا', 'error'); }
}

async function trainKeyword() {
  const k = document.getElementById('keywordInput').value.trim();
  const r = document.getElementById('keywordResponseInput').value.trim();
  if (!k || !r) return showNotification('کلمه کلیدی و پاسخ رو کامل کن!', 'error');
  try {
    const res = await fetch('/api/assistant/keyword', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id, keyword:k, response:r}) });
    const d = await res.json();
    if (d.success) { showNotification('✅ ثبت شد!', 'success'); document.getElementById('keywordInput').value = ''; document.getElementById('keywordResponseInput').value = ''; loadAssistant(); }
  } catch(e) { showNotification('خطا', 'error'); }
}

function showTrainingModal() { document.getElementById('trainingModal').style.display = 'flex'; }
async function trainFromModal() {
  const q = document.getElementById('trainQuestion').value.trim();
  const a = document.getElementById('trainAnswer').value.trim();
  if (!q || !a) return showNotification('سوال و جواب رو کامل کن!', 'error');
  try {
    const res = await fetch('/api/assistant/train', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id, question:q, answer:a}) });
    const d = await res.json();
    if (d.success) { showNotification('✅ یاد گرفت!', 'success'); document.getElementById('trainQuestion').value = ''; document.getElementById('trainAnswer').value = ''; closeModal('trainingModal'); loadAssistant(); }
  } catch(e) { showNotification('خطا', 'error'); }
}

async function testAssistant() {
  const i = document.getElementById('assistantPreviewInput');
  const msg = i.value.trim();
  if (!msg) return;
  appendMsg('assistantPreviewChat', msg, 'me');
  i.value = '';
  try {
    const res = await fetch(`/api/assistant/chat/${currentUser.id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:msg}) });
    const d = await res.json();
    appendMsg('assistantPreviewChat', d.reply || '🤖 هنوز آموزش ندیده', 'bot');
  } catch(e) { appendMsg('assistantPreviewChat', '⚠️ خطا', 'bot'); }
}
function appendMsg(cid, text, who) {
  const c = document.getElementById(cid);
  const d = document.createElement('div');
  d.className = 'mini-msg ' + who;
  d.textContent = text;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

function toggleSchedule() {
  const p = document.getElementById('schedulePanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') document.getElementById('startDate').value = new Date().toISOString().split('T')[0];
}
async function schedulePosts() {
  const count = parseInt(document.getElementById('postCount').value);
  const descs = document.getElementById('postDescriptions').value.split('\n').filter(s=>s.trim());
  const time = document.getElementById('postTime').value;
  const start = document.getElementById('startDate').value;
  if (!count || count<1) return showNotification('تعداد را وارد کن!', 'error');
  if (descs.length < count) return showNotification(`حداقل ${count} توضیح وارد کن`, 'error');
  if (!time || !start) return showNotification('زمان و تاریخ را مشخص کن!', 'error');
  const posts = [];
  for (let i=0; i<count; i++) {
    const d = new Date(start); d.setDate(d.getDate()+i);
    const [h,m] = time.split(':'); d.setHours(parseInt(h), parseInt(m), 0, 0);
    posts.push({ content: descs[i] || `پست ${i+1}`, scheduledTime: d.toISOString() });
  }
  try {
    const res = await fetch('/api/schedule/posts', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id, posts}) });
    const d = await res.json();
    if (d.success) { showNotification(`✅ ${d.posts.length} پست زمان‌بندی شد!`, 'success'); document.getElementById('postCount').value=''; document.getElementById('postDescriptions').value=''; toggleSchedule(); loadAssistant(); }
  } catch(e) { showNotification('خطا', 'error'); }
}
async function cancelScheduled(id) {
  if (!confirm('لغو شود؟')) return;
  try { await fetch(`/api/schedule/posts/${id}`, { method:'DELETE' }); showNotification('✅ لغو شد', 'success'); loadAssistant(); } catch(e) {}
}

// ======= چت =======
async function loadChatList() {
  try {
    const res = await fetch(`/api/chat/list/${currentUser.id}`);
    const data = await res.json();
    document.getElementById('chatList').innerHTML = data.length ? data.map(c => `
      <div class="chat-item" onclick="openChat('${c.id}','${escapeHtml(c.name)}','${c.avatar||defaultAvatar(c.name)}')">
        <img src="${c.avatar||defaultAvatar(c.name)}"><div class="chat-info"><strong>${escapeHtml(c.name)}</strong><p>${escapeHtml(c.lastMessage||'')}</p></div>
      </div>`).join('') : '<div class="empty-state"><i class="fas fa-comments"></i><h3>هنوز چتی نداری</h3><p>از اکسپلور یکی رو پیدا کن!</p></div>';
  } catch(e) { showNotification('خطا', 'error'); }
}

function openChat(id, name, avatar) {
  currentChatUser = { id, name, avatar };
  document.getElementById('chatWithName').textContent = name;
  document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
  document.getElementById('chatWindow').classList.add('open');
  document.getElementById('chatMessages').innerHTML = '';
  loadChatHistory(id);
}
function closeChatWindow() {
  document.getElementById('chatWindow').classList.remove('open');
  currentChatUser = null;
}

async function loadChatHistory(id) {
  try {
    const res = await fetch(`/api/chat/history/${currentUser.id}/${id}`);
    const msgs = await res.json();
    const c = document.getElementById('chatMessages');
    c.innerHTML = msgs.map(m => `<div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'} entering">${escapeHtml(m.message)}</div>`).join('');
    c.scrollTop = c.scrollHeight;
  } catch(e) {}
}

function sendMessage() {
  const i = document.getElementById('messageInput');
  const msg = i.value.trim();
  if (!msg || !currentChatUser) return;
  const c = document.getElementById('chatMessages');
  const d = document.createElement('div');
  d.className = 'message sent entering';
  d.textContent = msg;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
  i.value = '';
  socket.emit('private_message', { from: currentUser.id, to: currentChatUser.id, message: msg, timestamp: Date.now() });
}

function openChatFromProfile() {
  navigateTo('chat');
  setTimeout(() => openChat(viewingProfileId, document.getElementById('viewName').textContent, document.getElementById('viewAvatar').src), 300);
}

// ======= اکسپلور =======
async function loadExplore() {
  const filter = document.getElementById('exploreFilter').value;
  try {
    const res = await fetch(`/api/explore?page=${explorePage}&limit=12&filter=${filter}`);
    const data = await res.json();
    exploreTotalPages = data.pages || 1;
    const labels = { normal:'عادی', high:'🔥 داغ', viral:'🚀 وایرال', superstar:'⭐ ستاره' };
    document.getElementById('exploreContent').innerHTML = data.items?.length ? data.items.map(c => `
      <div class="explore-card" onclick="openProfile('${c.user_id}')">
        <img src="${c.avatar||defaultAvatar(c.name)}"><h4>${escapeHtml(c.name)}</h4>
        <div class="meta">${labels[c.boost_level]||'عادی'} · ${formatNumber(c.followers_count||0)} فالوور</div>
        <button class="follow-btn" onclick="event.stopPropagation(); quickFollow('${c.user_id}',this)"><i class="fas fa-user-plus"></i> فالو</button>
      </div>`).join('') : '<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-users-slash"></i><h3>هیچ کاربری یافت نشد</h3></div>';
    renderPagination(explorePage, exploreTotalPages, 'explore');
  } catch(e) { showNotification('خطا', 'error'); }
}

function renderPagination(cur, total, type) {
  const c = document.getElementById(type + 'Pagination');
  if (!c || total <= 1) { c.innerHTML = ''; return; }
  let html = '<div class="pagination">';
  if (cur > 1) html += `<button onclick="changePage('${type}',${cur-1})"><i class="fas fa-chevron-right"></i></button>`;
  for (let i=Math.max(1,cur-2); i<=Math.min(total,cur+2); i++) html += `<button onclick="changePage('${type}',${i})" ${i===cur?'class="active"':''}>${i}</button>`;
  if (cur < total) html += `<button onclick="changePage('${type}',${cur+1})"><i class="fas fa-chevron-left"></i></button>`;
  html += '</div>';
  c.innerHTML = html;
}
function changePage(type, p) {
  if (type === 'explore') { explorePage = p; loadExplore(); }
}

async function quickFollow(id, btn) {
  if (id === currentUser.id) return showNotification('نمی‌توانید خودتان را فالو کنید!', 'error');
  const isF = btn.textContent.includes('فالو شده');
  try {
    const res = await fetch(isF ? '/api/unfollow' : '/api/follow', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({followerId:currentUser.id, followingId:id}) });
    const d = await res.json();
    if (d.success) {
      if (isF) { btn.innerHTML = '<i class="fas fa-user-plus"></i> فالو'; btn.classList.remove('following'); } else { btn.innerHTML = '<i class="fas fa-check"></i> فالو شده'; btn.classList.add('following'); showNotification('✅ فالو شدید!', 'success'); updateScore(); }
    }
  } catch(e) {}
}

// ======= پروفایل =======
async function openProfile(id) {
  if (id === currentUser.id) return showProfileModal();
  viewingProfileId = id;
  try {
    const res = await fetch(`/api/profile/${id}?viewerId=${currentUser.id}`);
    const d = await res.json();
    document.getElementById('viewAvatar').src = d.user.avatar || defaultAvatar(d.user.name);
    document.getElementById('viewName').textContent = d.user.name;
    document.getElementById('viewBio').textContent = d.user.bio || '';
    document.getElementById('viewFollowers').textContent = formatNumber(d.channel?.followers_count || 0);
    document.getElementById('viewPosts').textContent = formatNumber(d.channel?.posts_count || 0);
    document.getElementById('viewScore').textContent = d.user.score || 0;
    viewingProfileFollowing = d.isFollowing || false;
    const fb = document.getElementById('viewFollowBtn');
    if (viewingProfileFollowing) { fb.innerHTML = '<i class="fas fa-check"></i> فالو شده'; fb.className = 'btn-secondary'; } else { fb.innerHTML = '<i class="fas fa-user-plus"></i> فالو'; fb.className = 'btn-primary'; }
    document.getElementById('viewPostsContainer').innerHTML = d.posts?.length ? d.posts.map(p => renderPost(p)).join('') : '<div class="empty-state"><i class="fas fa-file-alt"></i><h3>هیچ پستی منتشر نشده</h3></div>';
    document.getElementById('viewAssistantChat').innerHTML = '<div class="mini-msg bot">💬 سوال بپرس!</div>';
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.getElementById('profilePage').classList.add('active');
  } catch(e) { showNotification('خطا', 'error'); }
}

function backFromProfile() {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(currentPage + 'Page').classList.add('active');
}

async function toggleFollowView() {
  const endpoint = viewingProfileFollowing ? '/api/unfollow' : '/api/follow';
  const btn = document.getElementById('viewFollowBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const res = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({followerId:currentUser.id, followingId:viewingProfileId}) });
    const d = await res.json();
    if (d.success) {
      viewingProfileFollowing = !viewingProfileFollowing;
      if (viewingProfileFollowing) { btn.innerHTML = '<i class="fas fa-check"></i> فالو شده'; btn.className = 'btn-secondary'; document.getElementById('viewFollowers').textContent = formatNumber(parseInt(document.getElementById('viewFollowers').textContent.replace(/[^0-9]/g,'')) + 1); } else { btn.innerHTML = '<i class="fas fa-user-plus"></i> فالو'; btn.className = 'btn-primary'; document.getElementById('viewFollowers').textContent = formatNumber(Math.max(0, parseInt(document.getElementById('viewFollowers').textContent.replace(/[^0-9]/g,'')) - 1)); }
    }
  } catch(e) {}
  btn.disabled = false;
}

async function askOtherAssistant() {
  const i = document.getElementById('viewAssistantInput');
  const msg = i.value.trim();
  if (!msg || !viewingProfileId) return;
  appendMsg('viewAssistantChat', msg, 'me');
  i.value = '';
  try {
    const res = await fetch(`/api/assistant/chat/${viewingProfileId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:msg}) });
    const d = await res.json();
    appendMsg('viewAssistantChat', d.reply || '🤖 آموزش ندیده', 'bot');
  } catch(e) { appendMsg('viewAssistantChat', '⚠️ خطا', 'bot'); }
}

// ======= پروفایل شخصی =======
async function showProfileModal() {
  try {
    const res = await fetch(`/api/user/${currentUser.id}`);
    const d = await res.json();
    currentUser = { ...currentUser, ...d };
  } catch(e) {}
  document.getElementById('myAvatarPreview').src = currentUser.avatar || defaultAvatar(currentUser.name);
  document.getElementById('myNameInput').value = currentUser.name || '';
  document.getElementById('myBioInput').value = currentUser.bio || '';
  document.getElementById('myFollowers').textContent = formatNumber(currentUser.followers || 0);
  document.getElementById('myPosts').textContent = formatNumber(currentUser.posts || 0);
  document.getElementById('myScore').textContent = currentUser.score || 0;
  document.getElementById('profileModal').style.display = 'flex';
}

async function updateProfile() {
  const name = document.getElementById('myNameInput').value.trim();
  const bio = document.getElementById('myBioInput').value.trim();
  const avatar = document.getElementById('myAvatarPreview').src;
  if (!name) return showNotification('نام نمی‌تواند خالی باشد!', 'error');
  const btn = document.querySelector('#profileModal .btn-primary');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const res = await fetch('/api/user/update', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:currentUser.id, name, bio, avatar}) });
    const d = await res.json();
    if (d.success) {
      currentUser.name = name; currentUser.bio = bio; currentUser.avatar = avatar;
      document.getElementById('userName').textContent = name;
      document.getElementById('avatarImg').src = avatar || defaultAvatar(name);
      document.getElementById('composerAvatar').src = avatar || defaultAvatar(name);
      showNotification('✅ ذخیره شد!', 'success');
      closeModal('profileModal');
    }
  } catch(e) { showNotification('خطا', 'error'); }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> ذخیره';
}

// ======= شروع =======
document.addEventListener('DOMContentLoaded', init);