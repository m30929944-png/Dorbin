// ============================================
// اتصال WebSocket
// ============================================
const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 15000
});

let currentUser = null;
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;
let pendingMedia = null;
let pendingMediaType = null;
let scheduledMediaFiles = [];
let isAdmin = false;
let adminPanelOpen = false;
let currentTheme = 0;
const themes = ['default', 'blue', 'pink', 'green'];

// ============================================
// توابع کمکی
// ============================================
function defaultAvatar(seed) {
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed || 'user')}`;
}

function readFileAsBase64(file, cb) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => cb(e.target.result);
    reader.readAsDataURL(file);
}

function escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
    if (diff < 60) return 'همین الان';
    if (diff < 3600) return Math.floor(diff / 60) + ' دقیقه پیش';
    if (diff < 86400) return Math.floor(diff / 3600) + ' ساعت پیش';
    if (diff < 2592000) return Math.floor(diff / 86400) + ' روز پیش';
    return new Date(dateStr).toLocaleDateString('fa-IR');
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

function showNotification(text, type = 'info') {
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    
    const n = document.createElement('div');
    n.className = 'notification';
    
    if (type === 'broadcast') {
        n.style.cssText = `
            background: linear-gradient(135deg, rgba(74,222,128,0.15), rgba(34,197,94,0.15));
            border-color: var(--success);
            color: var(--success);
            padding: 16px 24px;
            border-radius: var(--radius);
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 12px;
        `;
        n.innerHTML = `<i class="fas fa-bullhorn" style="font-size:20px;"></i> ${text}`;
    } else {
        n.innerHTML = text;
    }
    
    document.body.appendChild(n);
    setTimeout(() => {
        n.style.opacity = '0';
        n.style.transform = 'translate(-50%, -30px)';
        setTimeout(() => n.remove(), 300);
    }, 3500);
}

function closeModal() {
    const m = document.querySelector('.modal');
    if (m) m.remove();
}

function appendMiniMsg(containerId, text, who) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const div = document.createElement('div');
    div.className = 'mini-msg ' + who;
    div.textContent = text;
    div.style.cssText = `
        padding: 8px 14px;
        border-radius: 14px;
        font-size: 13px;
        max-width: 85%;
        word-wrap: break-word;
        ${who === 'me' ? `
            align-self: flex-end;
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: #fff;
        ` : `
            align-self: flex-start;
            background: var(--bg-soft);
            border: 1px solid var(--border);
        `}
    `;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
}

function updateBoostBadge(level) {
    const badge = document.getElementById('boostBadge');
    if (!badge) return;
    const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
    badge.textContent = labels[level] || 'عادی';
}

// ============================================
// تغییر تم
// ============================================
function toggleTheme() {
    currentTheme = (currentTheme + 1) % themes.length;
    document.body.className = themes[currentTheme] === 'default' ? '' : 'theme-' + themes[currentTheme];
    localStorage.setItem('yareman_theme', themes[currentTheme]);
    showNotification('🎨 تم تغییر کرد');
}

function loadTheme() {
    const saved = localStorage.getItem('yareman_theme');
    if (saved && themes.includes(saved)) {
        currentTheme = themes.indexOf(saved);
        document.body.className = saved === 'default' ? '' : 'theme-' + saved;
    }
}

// ============================================
// مودال تمام صفحه
// ============================================
function openFullscreen(url, type) {
    const modal = document.getElementById('fullscreenModal');
    const content = document.getElementById('fullscreenContent');
    if (!modal || !content) return;
    
    if (type === 'video') {
        content.innerHTML = `<video src="${url}" controls autoplay style="max-width:100%;max-height:90vh;"></video>`;
    } else {
        content.innerHTML = `<img src="${url}" style="max-width:100%;max-height:90vh;">`;
    }
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeFullscreen() {
    const modal = document.getElementById('fullscreenModal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
    const content = document.getElementById('fullscreenContent');
    if (content) content.innerHTML = '';
}

// ============================================
// ورود / ثبت‌نام
// ============================================
async function initApp() {
    loadTheme();
    
    const savedId = localStorage.getItem('yareman_user_id');
    if (savedId) {
        try {
            const res = await fetch(`/api/user/${savedId}`);
            if (res.ok) {
                currentUser = await res.json();
                if (currentUser.id === 'admin_milad') {
                    isAdmin = true;
                    document.getElementById('adminBtn').classList.add('show');
                }
                afterLogin();
                return;
            }
        } catch (e) {}
    }
    showRegisterModal();
}

function showRegisterModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'registerModal';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>👋 خوش اومدی!</h2>
            <p style="color:var(--text-2);font-size:14px;margin-bottom:16px;">
                یه اسم برای خودت انتخاب کن
            </p>
            <div class="avatar-upload">
                <img id="regAvatarPreview" src="${defaultAvatar('guest')}">
                <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
            </div>
            <input type="text" id="regNameInput" class="name-input" placeholder="اسمت چیه؟" maxlength="30">
            <button class="btn-primary" style="width:100%;padding:14px;font-size:16px;" onclick="registerUser()">
                <i class="fas fa-rocket"></i> ورود به یارِ من
            </button>
            <p style="font-size:11px;color:var(--text-3);margin-top:10px;">
                با ثبت‌نام، قوانین و حریم خصوصی را می‌پذیرید
            </p>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('regAvatarInput').addEventListener('change', function(e) {
        readFileAsBase64(e.target.files[0], (b64) => {
            document.getElementById('regAvatarPreview').src = b64;
        });
    });
}

async function registerUser() {
    const name = document.getElementById('regNameInput').value.trim();
    if (!name) { showNotification('اسمت رو بنویس!'); return; }
    const avatar = document.getElementById('regAvatarPreview').src;

    try {
        const res = await fetch('/api/user/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, avatar })
        });
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('yareman_user_id', currentUser.id);
            document.getElementById('registerModal').remove();
            
            if (currentUser.id === 'admin_milad') {
                isAdmin = true;
                document.getElementById('adminBtn').classList.add('show');
                showNotification('👑 خوش آمدی مدیر سیستم!');
            } else {
                showNotification('✨ خوش آمدی ' + currentUser.name);
            }
            
            afterLogin();
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

function afterLogin() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('userScore').textContent = `🏆 ${formatNumber(currentUser.score || 0)}`;
    socket.emit('join', currentUser.id);
    setupNav();
    loadPageData('channel');
    
    socket.on('broadcast', (data) => {
        showNotification(`📢 ${data.title || 'اعلان'}: ${data.message}`, 'broadcast');
    });
}

// ============================================
// ناوبری
// ============================================
function setupNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            const pageId = this.dataset.page + 'Page';
            const page = document.getElementById(pageId);
            if (page) page.classList.add('active');
            loadPageData(this.dataset.page);
        });
    });
}

async function loadPageData(page) {
    switch (page) {
        case 'channel': await loadChannelPosts(); break;
        case 'assistant': await loadAssistantData(); break;
        case 'chat': await loadChatList(); break;
        case 'explore': await loadExplore(); break;
    }
}

// ============================================
// پروفایل
// ============================================
document.getElementById('profileBtn').addEventListener('click', showProfileModal);

async function showProfileModal() {
    try {
        const res = await fetch(`/api/user/${currentUser.id}`);
        currentUser = { ...currentUser, ...(await res.json()) };
    } catch (e) {}

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="avatar-upload">
                <img id="myAvatarPreview" src="${currentUser.avatar || defaultAvatar(currentUser.name)}">
                <label><i class="fas fa-camera"></i><input type="file" id="myAvatarInput" accept="image/*"></label>
            </div>
            <h3 style="font-size:20px;">${escapeHtml(currentUser.name)}</h3>
            ${currentUser.bio ? `<p style="color:var(--text-2);font-size:14px;">${escapeHtml(currentUser.bio)}</p>` : ''}
            <div style="display:flex;justify-content:center;gap:24px;margin:12px 0;">
                <div><b style="font-size:18px;">${formatNumber(currentUser.followers || 0)}</b><span style="font-size:12px;color:var(--text-3);display:block;">فالوور</span></div>
                <div><b style="font-size:18px;">${formatNumber(currentUser.score || 0)}</b><span style="font-size:12px;color:var(--text-3);display:block;">امتیاز</span></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
                <button class="btn-secondary" onclick="document.querySelector('[data-page=assistant]').click(); closeModal();">
                    <i class="fas fa-robot"></i> مدیریت دستیار
                </button>
                <button class="btn-ghost" onclick="closeModal()">بستن</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('myAvatarInput').addEventListener('change', function(e) {
        readFileAsBase64(e.target.files[0], async (b64) => {
            document.getElementById('myAvatarPreview').src = b64;
            document.getElementById('avatarImg').src = b64;
            currentUser.avatar = b64;
            await fetch('/api/user/avatar', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, avatar: b64 })
            });
            showNotification('✅ عکس پروفایل به‌روز شد');
        });
    });
}

// ============================================
// پست‌ها
// ============================================
document.getElementById('postImageInput').addEventListener('change', function(e) {
    handleMediaFile(e.target.files[0], 'image');
});

document.getElementById('postVideoInput').addEventListener('change', function(e) {
    handleMediaFile(e.target.files[0], 'video');
});

function handleMediaFile(file, type) {
    if (!file) return;
    const maxSize = type === 'video' ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
    if (file.size > maxSize) {
        showNotification(`حجم فایل بیش از حد مجاز است (حداکثر ${type === 'video' ? '50' : '10'}MB)`);
        return;
    }
    readFileAsBase64(file, (b64) => {
        pendingMedia = b64;
        pendingMediaType = type;
        showMediaPreview(b64, type);
    });
}

function showMediaPreview(b64, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;
    container.style.display = 'block';
    if (type === 'video') {
        content.innerHTML = `<video src="${b64}" controls style="width:100%;max-height:400px;"></video>`;
    } else {
        content.innerHTML = `<img src="${b64}" style="width:100%;max-height:400px;">`;
    }
}

function removeMedia() {
    pendingMedia = null;
    pendingMediaType = null;
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (container) container.style.display = 'none';
    if (content) content.innerHTML = '';
    document.getElementById('postImageInput').value = '';
    document.getElementById('postVideoInput').value = '';
}

async function createPost() {
    const content = document.getElementById('postContent').value.trim();
    if (!content) { showNotification('یه متنی برای پست بنویس!'); return; }

    try {
        const res = await fetch('/api/post/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                content,
                mediaUrl: pendingMedia,
                mediaType: pendingMediaType || 'none'
            })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('postContent').value = '';
            removeMedia();
            showNotification('✅ پست منتشر شد');
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            await loadChannelPosts();
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

async function loadChannelPosts() {
    try {
        const res = await fetch(`/api/channel/${currentUser.id}`);
        const posts = await res.json();
        const container = document.getElementById('channelPosts');
        if (!container) return;
        
        if (!posts.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-pen-fancy"></i>
                هنوز پستی منتشر نکردی.<br>
                اولین پستت رو بنویس! ✍️
            </div>`;
            return;
        }
        
        container.innerHTML = posts.map(p => renderPostCard(p, currentUser)).join('');

        const ures = await fetch(`/api/user/${currentUser.id}`);
        const u = await ures.json();
        document.getElementById('followersCount').textContent = `${formatNumber(u.followers || 0)} فالوور`;
    } catch (e) { console.error(e); }
}

function renderPostCard(post, author) {
    const name = author?.name || post.channel_name || 'کاربر';
    const avatar = author?.avatar || defaultAvatar(name);
    
    // تشخیص هشتگ‌ها
    let contentHtml = escapeHtml(post.content);
    contentHtml = contentHtml.replace(/#(\w+)/g, '<span class="hashtag">#$1</span>');
    
    const mediaHtml = post.media_url ? `
        <div class="media-wrapper">
            ${post.media_type === 'video' ? 
                `<video src="${post.media_url}" controls preload="metadata" style="width:100%;"></video>` : 
                `<img src="${post.media_url}" loading="lazy" style="width:100%;cursor:pointer;" onclick="event.stopPropagation(); openFullscreen('${post.media_url}', 'image')">`}
            <button class="fullscreen-btn" onclick="event.stopPropagation(); openFullscreen('${post.media_url}', '${post.media_type === 'video' ? 'video' : 'image'}')">
                <i class="fas fa-expand"></i>
            </button>
        </div>` : '';
    
    return `
    <div class="post-card" data-post-id="${post.id}">
        <div class="post-head" onclick="openProfile('${post.user_id || currentUser.id}')">
            <img src="${avatar}" loading="lazy">
            <span class="name">${escapeHtml(name)}</span>
            <span class="time">${timeAgo(post.created_at)}</span>
        </div>
        <p class="content">${contentHtml}</p>
        ${mediaHtml}
        <div class="post-stats">
            <button class="btn-like" onclick="toggleLike('${post.id}', this)">
                <i class="far fa-heart"></i> <span class="like-count">${formatNumber(post.likes || 0)}</span>
            </button>
            <button class="btn-comment" onclick="toggleComments('${post.id}', this)">
                <i class="far fa-comment"></i> <span class="comment-count">${formatNumber(post.comments || 0)}</span>
            </button>
            <button class="btn-share" onclick="sharePost('${post.id}')">
                <i class="fas fa-share-alt"></i>
            </button>
        </div>
        <div class="comments-box" id="comments-${post.id}" style="display:none;margin-top:12px;border-top:2px solid var(--border);padding-top:12px;"></div>
    </div>`;
}

function sharePost(postId) {
    const url = window.location.href + '?post=' + postId;
    if (navigator.share) {
        navigator.share({ title: 'یارِ من', text: 'این پست رو ببین!', url: url });
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showNotification('✅ لینک پست کپی شد');
        }).catch(() => {
            showNotification('لینک: ' + url);
        });
    }
}

async function toggleLike(postId, btn) {
    try {
        const res = await fetch(`/api/post/${postId}/like`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });
        const data = await res.json();
        if (data.success) {
            btn.classList.toggle('active', data.liked);
            btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
            btn.querySelector('.like-count').textContent = formatNumber(data.likes);
        }
    } catch (e) { showNotification('خطا'); }
}

async function toggleComments(postId, btn) {
    const box = document.getElementById(`comments-${postId}`);
    if (!box) return;
    const isOpen = box.style.display !== 'none';
    box.style.display = isOpen ? 'none' : 'block';
    
    if (!isOpen && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        try {
            const res = await fetch(`/api/post/${postId}/comments`);
            const comments = await res.json();
            box.innerHTML = (comments.map(c => `
                <div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start;">
                    <img src="${c.avatar || defaultAvatar(c.name)}" style="width:32px;height:32px;border-radius:50%;">
                    <div>
                        <b style="font-size:13px;">${escapeHtml(c.name)}</b>
                        <p style="font-size:13px;color:var(--text-2);">${escapeHtml(c.text)}</p>
                    </div>
                </div>
            `).join('') || '') + `
                <div style="display:flex;gap:8px;margin-top:8px;">
                    <input type="text" id="commentInput-${postId}" placeholder="کامنت بنویس..." style="flex:1;background:var(--bg-soft);border:2px solid var(--border);border-radius:99px;padding:10px 16px;color:var(--text);font-size:14px;outline:none;">
                    <button class="btn-secondary" onclick="submitComment('${postId}')" style="padding:10px 20px;">ارسال</button>
                </div>`;
        } catch (e) { showNotification('خطا'); }
    }
}

async function submitComment(postId) {
    const input = document.getElementById(`commentInput-${postId}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
        const res = await fetch(`/api/post/${postId}/comment`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, text })
        });
        const data = await res.json();
        if (data.success) {
            input.value = '';
            const box = document.getElementById(`comments-${postId}`);
            if (!box) return;
            const form = box.querySelector('div:last-child');
            const item = document.createElement('div');
            item.style.cssText = 'display:flex;gap:10px;margin-bottom:8px;align-items:flex-start;';
            item.innerHTML = `
                <img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" style="width:32px;height:32px;border-radius:50%;">
                <div>
                    <b style="font-size:13px;">${escapeHtml(data.comment.name)}</b>
                    <p style="font-size:13px;color:var(--text-2);">${escapeHtml(data.comment.text)}</p>
                </div>
            `;
            box.insertBefore(item, form);
            const card = document.querySelector(`[data-post-id="${postId}"] .comment-count`);
            if (card) card.textContent = formatNumber(parseInt(card.textContent.replace(/,/g, '')) + 1);
        }
    } catch (e) { showNotification('خطا'); }
}

// ============================================
// دستیار
// ============================================
async function loadAssistantData() {
    try {
        const res = await fetch(`/api/assistant/${currentUser.id}`);
        const data = await res.json();

        document.getElementById('statPosts').textContent = formatNumber(data.stats?.totalPosts ?? 0);
        document.getElementById('statTrainings').textContent = formatNumber(data.stats?.totalTrainings ?? 0);
        document.getElementById('statFollowers').textContent = formatNumber(data.stats?.followers ?? 0);
        document.getElementById('statEngagement').textContent = data.stats?.engagementRate ?? '0%';

        const qaList = document.getElementById('qaList');
        if (qaList) {
            qaList.innerHTML = data.qa?.length ? data.qa.map(q => `
                <div style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;font-size:13px;">
                    <div style="color:var(--text-2);">❓ ${escapeHtml(q.question)}</div>
                    <div>💬 ${escapeHtml(q.answer)}</div>
                </div>
            `).join('') : '<div class="empty-state">هنوز آموزشی ثبت نشده.</div>';
        }

        const keywordList = document.getElementById('keywordList');
        if (keywordList) {
            keywordList.innerHTML = data.keywords?.length ? data.keywords.map(k => `
                <div style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;font-size:13px;">
                    <div style="color:var(--text-2);">🔑 ${escapeHtml(k.keyword)}</div>
                    <div>💬 ${escapeHtml(k.response)}</div>
                </div>
            `).join('') : '<div class="empty-state">هنوز کلمه کلیدی ثبت نشده.</div>';
        }
    } catch (e) { console.error(e); }
}

async function trainAssistant() {
    const question = document.getElementById('questionInput').value.trim();
    const answer = document.getElementById('answerInput').value.trim();
    if (!question || !answer) { showNotification('سوال و جواب رو کامل کن!'); return; }

    try {
        const res = await fetch('/api/assistant/train', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, question, answer })
        });
        const data = await res.json();
        if (data.success) {
            showNotification('✅ دستیار یاد گرفت');
            document.getElementById('questionInput').value = '';
            document.getElementById('answerInput').value = '';
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            await loadAssistantData();
        }
    } catch (e) { showNotification('خطا'); }
}

async function trainKeyword() {
    const keyword = document.getElementById('keywordInput').value.trim();
    const response = document.getElementById('keywordResponseInput').value.trim();
    if (!keyword || !response) { showNotification('کلمه کلیدی و پاسخ رو کامل کن!'); return; }

    try {
        const res = await fetch('/api/assistant/keyword', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, keyword, response })
        });
        const data = await res.json();
        if (data.success) {
            showNotification('✅ کلمه کلیدی ثبت شد');
            document.getElementById('keywordInput').value = '';
            document.getElementById('keywordResponseInput').value = '';
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            await loadAssistantData();
        }
    } catch (e) { showNotification('خطا'); }
}

async function testAssistant() {
    const input = document.getElementById('assistantPreviewInput');
    const msg = input.value.trim();
    if (!msg) return;
    appendMiniMsg('assistantPreviewChat', msg, 'me');
    input.value = '';

    try {
        const res = await fetch(`/api/assistant/chat/${currentUser.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        appendMiniMsg('assistantPreviewChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'bot');
    } catch (e) { showNotification('خطا'); }
}

// ============================================
// اکسپلور
// ============================================
async function loadExplore() {
    try {
        const res = await fetch('/api/explore');
        const items = await res.json();
        const container = document.getElementById('exploreContent');
        if (!container) return;
        
        if (!items.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-compass"></i>
                هنوز پستی در اکسپلور وجود نداره.<br>
                اولین پست رو تو منتشر کن! 🚀
            </div>`;
            return;
        }

        container.innerHTML = items.map(user => {
            const postsHtml = user.recent_posts && user.recent_posts.length ? 
                user.recent_posts.map(p => {
                    let contentHtml = escapeHtml(p.content || '').substring(0, 120);
                    contentHtml = contentHtml.replace(/#(\w+)/g, '<span class="hashtag">#$1</span>');
                    
                    return `
                    <div class="explore-post-mini" onclick="event.stopPropagation(); openPostDetail('${p.id}')">
                        <p>${contentHtml}${(p.content || '').length > 120 ? '...' : ''}</p>
                        ${p.media_url ? `
                            <div class="mini-media">
                                ${p.media_type === 'video' ? 
                                    `<video src="${p.media_url}" muted preload="metadata" style="width:100%;"></video>` : 
                                    `<img src="${p.media_url}" loading="lazy" style="width:100%;">`}
                            </div>
                        ` : ''}
                        <div class="mini-stats">
                            <span><i class="far fa-heart"></i> ${formatNumber(p.likes || 0)}</span>
                            <span><i class="far fa-comment"></i> ${formatNumber(p.comments || 0)}</span>
                            <span><i class="far fa-eye"></i> ${formatNumber(p.views || 0)}</span>
                        </div>
                    </div>
                `}).join('') : 
                `<p style="font-size:12px;color:var(--text-3);padding:6px 0;">هنوز پستی منتشر نشده</p>`;

            return `
                <div class="explore-user-card">
                    <div class="explore-user-header">
                        <img src="${user.avatar || defaultAvatar(user.name)}" loading="lazy" onclick="openProfile('${user.user_id}')">
                        <div class="info" onclick="openProfile('${user.user_id}')">
                            <h4>${escapeHtml(user.name)}</h4>
                            <div class="meta">⭐ ${formatNumber(user.followers_count || 0)} فالوور · ${formatNumber(user.posts_count || 0)} پست</div>
                        </div>
                        <button class="btn-follow follow" onclick="event.stopPropagation(); quickFollow('${user.user_id}', this)">
                            فالو
                        </button>
                    </div>
                    <div class="explore-posts">
                        ${postsHtml}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) { console.error(e); }
}

function openPostDetail(postId) {
    document.querySelector('[data-page="channel"]').click();
    setTimeout(() => {
        const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.borderColor = 'var(--primary)';
            card.style.boxShadow = 'var(--shadow-glow)';
            setTimeout(() => {
                card.style.borderColor = '';
                card.style.boxShadow = '';
            }, 3000);
        } else {
            showNotification('پست پیدا نشد');
        }
    }, 500);
}

async function quickFollow(userId, btn) {
    if (userId === currentUser.id) {
        showNotification('نمی‌توانید خودتان را فالو کنید');
        return;
    }
    
    const isFollowing = btn.classList.contains('following');
    
    try {
        const endpoint = isFollowing ? '/api/unfollow' : '/api/follow';
        const res = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ followerId: currentUser.id, followingId: userId })
        });
        const data = await res.json();
        if (data.success) {
            if (isFollowing) {
                btn.textContent = 'فالو';
                btn.className = 'btn-follow follow';
                showNotification('❌ آنفالو شد');
            } else {
                btn.textContent = 'فالو شد ✓';
                btn.className = 'btn-follow following';
                showNotification('✅ فالو شد');
            }
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

// ============================================
// پروفایل عمومی
// ============================================
async function openProfile(userId) {
    viewingProfileId = userId;
    try {
        const res = await fetch(`/api/profile/${userId}?viewerId=${currentUser.id}`);
        const data = await res.json();

        document.getElementById('viewAvatar').src = data.user.avatar || defaultAvatar(data.user.name);
        document.getElementById('viewName').textContent = data.user.name;
        document.getElementById('viewBio').textContent = data.user.bio || '';
        document.getElementById('viewFollowers').textContent = formatNumber(data.channel?.followers_count || 0);
        document.getElementById('viewPosts').textContent = formatNumber(data.channel?.posts_count || 0);
        document.getElementById('viewScore').textContent = formatNumber(data.user.score || 0);

        viewingProfileFollowing = data.isFollowing;
        const followBtn = document.getElementById('viewFollowBtn');
        if (followBtn) {
            followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
            followBtn.className = viewingProfileFollowing ? 'btn-follow following' : 'btn-follow follow';
        }

        const container = document.getElementById('viewPostsContainer');
        if (container) {
            container.innerHTML = data.posts.length ?
                data.posts.map(p => renderPostCard(p, data.user)).join('') :
                `<div class="empty-state">
                    <i class="fas fa-pen-fancy"></i>
                    این کاربر هنوز پستی منتشر نکرده.
                </div>`;
        }

        document.getElementById('viewAssistantChat').innerHTML = '';

        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const profilePage = document.getElementById('profilePage');
        if (profilePage) profilePage.classList.add('active');
    } catch (e) { showNotification('خطا در بارگذاری پروفایل'); }
}

function backFromProfile() {
    document.querySelector('[data-page="explore"]').click();
}

async function toggleFollowView() {
    if (!viewingProfileId) return;
    const isFollowing = viewingProfileFollowing;
    const endpoint = isFollowing ? '/api/unfollow' : '/api/follow';
    try {
        const res = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ followerId: currentUser.id, followingId: viewingProfileId })
        });
        const data = await res.json();
        if (data.success) {
            viewingProfileFollowing = !isFollowing;
            const followBtn = document.getElementById('viewFollowBtn');
            if (followBtn) {
                followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
                followBtn.className = viewingProfileFollowing ? 'btn-follow following' : 'btn-follow follow';
            }
            const count = document.getElementById('viewFollowers');
            if (count) count.textContent = formatNumber(parseInt(count.textContent.replace(/,/g, '')) + (viewingProfileFollowing ? 1 : -1));
            showNotification(viewingProfileFollowing ? '✅ فالو شد' : '❌ آنفالو شد');
        }
    } catch (e) { showNotification('خطا'); }
}

async function askOtherAssistant() {
    const input = document.getElementById('viewAssistantInput');
    const msg = input.value.trim();
    if (!msg || !viewingProfileId) return;
    appendMiniMsg('viewAssistantChat', msg, 'me');
    input.value = '';

    try {
        const res = await fetch(`/api/assistant/chat/${viewingProfileId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        appendMiniMsg('viewAssistantChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'bot');
    } catch (e) { showNotification('خطا'); }
}

function openChatFromProfile() {
    document.querySelector('[data-page="chat"]').click();
    openChat(viewingProfileId, document.getElementById('viewName').textContent, document.getElementById('viewAvatar').src);
}

// ============================================
// چت خصوصی
// ============================================
async function loadChatList() {
    try {
        const res = await fetch(`/api/chat/list/${currentUser.id}`);
        const chats = await res.json();
        const container = document.getElementById('chatList');
        if (!container) return;
        
        if (!chats.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-comment-dots"></i>
                هنوز چتی نداری.<br>
                از اکسپلور یکی رو پیدا کن و پیام بده! 💬
            </div>`;
            return;
        }
        
        container.innerHTML = chats.map(c => `
            <div class="chat-item" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
                <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                <div class="info">
                    <strong>${escapeHtml(c.name)}</strong>
                    <p>${escapeHtml(c.lastMessage || '')}</p>
                </div>
                ${c.unreadCount > 0 ? `<span style="background:var(--primary);color:#fff;font-size:12px;padding:2px 10px;border-radius:99px;">${c.unreadCount}</span>` : ''}
            </div>
        `).join('');
    } catch (e) { console.error(e); }
}

async function openChat(userId, name, avatar) {
    currentChatUser = { id: userId, name, avatar };
    document.getElementById('chatWithName').textContent = name || 'کاربر';
    document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
    document.getElementById('chatWindow').classList.add('open');
    document.getElementById('chatMessages').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-3);"><i class="fas fa-spinner fa-spin"></i> بارگذاری...</div>';

    try {
        await fetch('/api/chat/read', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, fromUser: userId })
        });
        await loadChatList();
    } catch (e) {}

    try {
        const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
        const messages = await res.json();
        const container = document.getElementById('chatMessages');
        container.innerHTML = messages.map(m => `
            <div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'}">
                ${escapeHtml(m.message)}
                <span style="font-size:10px;opacity:0.6;display:block;margin-top:2px;">${new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        `).join('');
        container.scrollTop = container.scrollHeight;
    } catch (e) { showNotification('خطا'); }
}

function closeChatWindow() {
    document.getElementById('chatWindow').classList.remove('open');
    currentChatUser = null;
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !currentChatUser) return;

    socket.emit('private_message', { 
        from: currentUser.id, 
        to: currentChatUser.id, 
        message, 
        timestamp: Date.now() 
    });
    
    displayMessage(message, 'sent');
    input.value = '';
}

function displayMessage(text, type) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.innerHTML = `${escapeHtml(text)}<span style="font-size:10px;opacity:0.6;display:block;margin-top:2px;">${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

socket.on('new_message', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
        displayMessage(data.message, 'received');
    } else {
        showNotification(`📩 پیام جدید از ${data.from}`);
        loadChatList();
    }
});

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const q = e.target.value.trim();
    const container = document.querySelector('.search-box');
    let resultsBox = document.getElementById('searchResults');
    
    if (q.length < 2) {
        if (resultsBox) resultsBox.remove();
        return;
    }
    
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const results = await res.json();
        
        if (!resultsBox) {
            resultsBox = document.createElement('div');
            resultsBox.id = 'searchResults';
            resultsBox.style.cssText = `
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: var(--bg-card);
                border: 2px solid var(--border);
                border-radius: var(--radius-sm);
                margin-top: 8px;
                max-height: 300px;
                overflow-y: auto;
                z-index: 50;
                box-shadow: var(--shadow);
            `;
            container.style.position = 'relative';
            container.appendChild(resultsBox);
        }
        
        if (!results.length) {
            resultsBox.innerHTML = `<div style="padding:12px;color:var(--text-3);">نتیجه‌ای یافت نشد</div>`;
            return;
        }
        
        resultsBox.innerHTML = results.map(r => `
            <div style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);transition:var(--transition);"
                 onclick="openProfile('${r.id}')" 
                 onmouseover="this.style.background='var(--bg-soft)'"
                 onmouseout="this.style.background=''">
                <i class="fas fa-${r.type === 'user' ? 'user' : 'bullhorn'}" style="color:var(--primary);"></i>
                <span style="font-weight:500;">${escapeHtml(r.name)}</span>
                <span style="font-size:11px;color:var(--text-3);">${r.type === 'user' ? 'کاربر' : 'کانال'}</span>
            </div>
        `).join('');
    } catch (e) { console.error(e); }
}, 400));

function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ============================================
// پنل مدیریت
// ============================================
function toggleAdminPanel() {
    if (!isAdmin) return;
    adminPanelOpen = !adminPanelOpen;
    if (adminPanelOpen) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const adminPage = document.getElementById('adminPage');
        if (adminPage) adminPage.classList.add('active');
        loadAdminData('stats');
    } else {
        document.querySelector('[data-page="channel"]').click();
    }
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    
    document.querySelectorAll('.admin-tab-content').forEach(c => c.style.display = 'none');
    const content = document.getElementById('admin' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (content) content.style.display = 'block';
    loadAdminData(tab);
}

async function loadAdminData(type) {
    try {
        if (type === 'stats') {
            const res = await fetch('/api/admin/stats', { headers: { 'userId': 'admin_milad' } });
            const stats = await res.json();
            const container = document.getElementById('adminStatsContent');
            if (container) {
                container.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
                        <div class="stat-chip" style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;text-align:center;">
                            <b style="font-size:22px;color:var(--primary);">${formatNumber(stats.users)}</b>
                            <span style="display:block;font-size:12px;color:var(--text-3);">کاربران</span>
                        </div>
                        <div class="stat-chip" style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;text-align:center;">
                            <b style="font-size:22px;color:var(--success);">${formatNumber(stats.posts)}</b>
                            <span style="display:block;font-size:12px;color:var(--text-3);">پست‌ها</span>
                        </div>
                        <div class="stat-chip" style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;text-align:center;">
                            <b style="font-size:22px;color:var(--secondary);">${formatNumber(stats.channels)}</b>
                            <span style="display:block;font-size:12px;color:var(--text-3);">کانال‌ها</span>
                        </div>
                        <div class="stat-chip" style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;text-align:center;">
                            <b style="font-size:22px;color:var(--info);">${formatNumber(stats.messages)}</b>
                            <span style="display:block;font-size:12px;color:var(--text-3);">پیام‌ها</span>
                        </div>
                        <div class="stat-chip" style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;text-align:center;">
                            <b style="font-size:22px;color:var(--like);">${formatNumber(stats.follows)}</b>
                            <span style="display:block;font-size:12px;color:var(--text-3);">فالوها</span>
                        </div>
                        <div class="stat-chip" style="background:var(--bg-soft);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;text-align:center;">
                            <b style="font-size:22px;color:var(--warning);">${formatNumber(stats.trainings)}</b>
                            <span style="display:block;font-size:12px;color:var(--text-3);">آموزش‌ها</span>
                        </div>
                    </div>
                `;
            }
        } else if (type === 'users') {
            const res = await fetch('/api/admin/users', { headers: { 'userId': 'admin_milad' } });
            const users = await res.json();
            const container = document.getElementById('adminUsersList');
            if (container) {
                container.innerHTML = users.map(u => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:2px solid var(--border);flex-wrap:wrap;gap:6px;">
                        <span style="font-weight:500;">${escapeHtml(u.name)}</span>
                        <span style="font-size:11px;color:var(--text-3);">${u.role || 'user'}</span>
                        <span style="font-size:11px;color:var(--text-3);">${formatNumber(u.followers_count || 0)} فالوور</span>
                        <div style="display:flex;gap:4px;">
                            ${u.role !== 'admin' ? `
                                <button class="btn-success" onclick="adminAction('user','${u.id}','verify')" style="padding:4px 14px;border-radius:99px;font-size:11px;border:none;cursor:pointer;">✓</button>
                                <button class="btn-danger" onclick="adminAction('user','${u.id}','ban')" style="padding:4px 14px;border-radius:99px;font-size:11px;border:none;cursor:pointer;">⛔</button>
                            ` : '<span style="color:var(--secondary);">👑</span>'}
                        </div>
                    </div>
                `).join('');
            }
        } else if (type === 'posts') {
            const res = await fetch('/api/admin/posts', { headers: { 'userId': 'admin_milad' } });
            const posts = await res.json();
            const container = document.getElementById('adminPostsList');
            if (container) {
                container.innerHTML = posts.map(p => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:2px solid var(--border);flex-wrap:wrap;gap:6px;">
                        <span>${escapeHtml(p.content?.substring(0, 50) || '')}...</span>
                        <span style="font-size:11px;color:var(--text-3);">${escapeHtml(p.user_name)}</span>
                        <span style="font-size:11px;color:var(--text-3);">${timeAgo(p.created_at)}</span>
                        <button class="btn-danger" onclick="adminAction('post','${p.id}','delete')" style="padding:4px 14px;border-radius:99px;font-size:11px;border:none;cursor:pointer;">🗑️</button>
                    </div>
                `).join('');
            }
        } else if (type === 'channels') {
            const res = await fetch('/api/admin/channels', { headers: { 'userId': 'admin_milad' } });
            const channels = await res.json();
            const container = document.getElementById('adminChannelsList');
            if (container) {
                container.innerHTML = channels.map(c => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:2px solid var(--border);flex-wrap:wrap;gap:6px;">
                        <span>${escapeHtml(c.name)}</span>
                        <span style="font-size:11px;color:var(--text-3);">${formatNumber(c.followers_count)} فالوور</span>
                        <span style="font-size:11px;color:var(--text-3);">${c.boost_level}</span>
                        <span style="font-size:11px;color:var(--text-3);">${formatNumber(c.posts_count)} پست</span>
                    </div>
                `).join('');
            }
        }
    } catch (e) { console.error(e); }
}

async function adminAction(type, id, action) {
    if (!confirm(`آیا از انجام این عملیات مطمئن هستید؟`)) return;
    try {
        const res = await fetch(`/api/admin/${type}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ 
                userId: type === 'user' ? id : undefined,
                postId: type === 'post' ? id : undefined
            })
        });
        const data = await res.json();
        if (data.success) {
            showNotification('✅ عملیات با موفقیت انجام شد');
            const activeTab = document.querySelector('.admin-tab.active');
            if (activeTab) loadAdminData(activeTab.dataset.tab);
        }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function sendBroadcast() {
    const title = document.getElementById('broadcastTitle').value.trim();
    const message = document.getElementById('broadcastMessage').value.trim();
    if (!message) { showNotification('متن پیام رو بنویس!'); return; }

    try {
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ title: title || '📢 اعلان سیستمی', message })
        });
        const data = await res.json();
        if (data.success) {
            showNotification(`✅ ${data.message}`, 'broadcast');
            document.getElementById('broadcastTitle').value = '';
            document.getElementById('broadcastMessage').value = '';
        }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

// ============================================
// شروع برنامه
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    
    setInterval(() => {
        if (document.getElementById('chatPage').classList.contains('active')) {
            loadChatList();
        }
    }, 30000);
});

// ============================================
// کلیدهای ESC
// ============================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeFullscreen();
        closeModal();
    }
});