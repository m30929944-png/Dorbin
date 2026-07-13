// ============================================
// اتصال به سرور با WebSocket
// ============================================
const socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 10 });

let currentUser = null;
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;

// ============================================
// ورود / ثبت‌نام ساده (شناسه در همین مرورگر ذخیره می‌شود)
// ============================================
async function initApp() {
    const savedId = localStorage.getItem('yareman_user_id');
    if (savedId) {
        try {
            const res = await fetch(`/api/user/${savedId}`);
            if (res.ok) {
                currentUser = await res.json();
                afterLogin();
                return;
            }
        } catch (e) { /* ادامه به فرم ثبت‌نام */ }
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
            <div class="avatar-upload">
                <img id="regAvatarPreview" src="https://api.dicebear.com/7.x/thumbs/svg?seed=guest">
                <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
            </div>
            <input type="text" id="regNameInput" class="name-input" placeholder="اسمت چیه؟" maxlength="30">
            <button class="btn-primary" style="width:100%;padding:12px;" onclick="registerUser()">ورود به یارِ من</button>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('regAvatarInput').addEventListener('change', function(e) {
        readImageAsBase64(e.target.files[0], (b64) => {
            document.getElementById('regAvatarPreview').src = b64;
        });
    });
}

async function registerUser() {
    const name = document.getElementById('regNameInput').value.trim();
    if (!name) { alert('اسمت رو بنویس!'); return; }
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
            afterLogin();
        } else {
            alert('خطا: ' + data.error);
        }
    } catch (e) { alert('خطا در ارتباط با سرور'); }
}

function afterLogin() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('userScore').textContent = `🏆 ${currentUser.score || 0}`;
    socket.emit('join', currentUser.id);
    setupNav();
    loadPageData('channel');
}

function defaultAvatar(seed) {
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed || 'user')}`;
}

function readImageAsBase64(file, cb) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => cb(e.target.result);
    reader.readAsDataURL(file);
}

// ============================================
// ناوبری صفحات
// ============================================
function setupNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(this.dataset.page + 'Page').classList.add('active');
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
// پروفایل خودم
// ============================================
document.getElementById('profileBtn').addEventListener('click', showProfileModal);

async function showProfileModal() {
    const res = await fetch(`/api/user/${currentUser.id}`);
    currentUser = { ...currentUser, ...(await res.json()) };

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="avatar-upload">
                <img id="myAvatarPreview" src="${currentUser.avatar || defaultAvatar(currentUser.name)}">
                <label><i class="fas fa-camera"></i><input type="file" id="myAvatarInput" accept="image/*"></label>
            </div>
            <h3>${currentUser.name}</h3>
            <div class="profile-stats">
                <div><b>${currentUser.followers || 0}</b><span>فالوور</span></div>
                <div><b>${currentUser.score || 0}</b><span>امتیاز</span></div>
            </div>
            <div class="profile-actions">
                <button class="btn-secondary" onclick="document.querySelector('[data-page=assistant]').click(); closeModal();">🤖 مدیریت دستیار</button>
                <button class="btn-ghost" onclick="closeModal()">بستن</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('myAvatarInput').addEventListener('change', function(e) {
        readImageAsBase64(e.target.files[0], async (b64) => {
            document.getElementById('myAvatarPreview').src = b64;
            document.getElementById('avatarImg').src = b64;
            currentUser.avatar = b64;
            await fetch('/api/user/avatar', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, avatar: b64 })
            });
        });
    });
}

function closeModal() {
    const m = document.querySelector('.modal');
    if (m) m.remove();
}

// ============================================
// کانال - ساخت و نمایش پست
// ============================================
let pendingPostImage = null;
document.getElementById('postImageInput').addEventListener('change', function(e) {
    readImageAsBase64(e.target.files[0], (b64) => { pendingPostImage = b64; });
});

async function createPost() {
    const content = document.getElementById('postContent').value.trim();
    if (!content) { alert('یه متنی برای پست بنویس!'); return; }

    try {
        const res = await fetch('/api/post/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id, content,
                mediaUrl: pendingPostImage, mediaType: pendingPostImage ? 'image' : null
            })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('postContent').value = '';
            pendingPostImage = null;
            showNotification('✅ پست منتشر شد');
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            loadChannelPosts();
        } else {
            alert('خطا: ' + data.error);
        }
    } catch (e) { alert('خطا در ارتباط با سرور'); }
}

async function loadChannelPosts() {
    try {
        const res = await fetch(`/api/channel/${currentUser.id}/posts`);
        const posts = await res.json();
        document.getElementById('channelPosts').innerHTML = posts.length ? posts.map(p => renderPostCard(p, currentUser)).join('') :
            '<p class="empty-state">هنوز پستی منتشر نکردی. اولین پستت رو بنویس! ✍️</p>';

        const ures = await fetch(`/api/user/${currentUser.id}`);
        const u = await ures.json();
        document.getElementById('followersCount').textContent = `${u.followers || 0} فالوور`;
    } catch (e) { console.error(e); }
}

function renderPostCard(post, author) {
    const name = author?.name || post.channel_name || 'کاربر';
    const avatar = author?.avatar || defaultAvatar(name);
    return `
    <div class="post-card" data-post-id="${post.id}">
        <div class="post-head">
            <img src="${avatar}">
            <span class="name">${name}</span>
            <span class="time">${timeAgo(post.created_at)}</span>
        </div>
        <p class="content">${escapeHtml(post.content)}</p>
        ${post.media_url ? `<img class="media" src="${post.media_url}">` : ''}
        <div class="post-stats">
            <button onclick="toggleLike('${post.id}', this)"><i class="far fa-heart"></i> <span class="like-count">${post.likes || 0}</span></button>
            <button onclick="toggleComments('${post.id}', this)"><i class="far fa-comment"></i> <span class="comment-count">${post.comments || 0}</span></button>
            <button disabled><i class="far fa-eye"></i> ${post.views || 0}</button>
        </div>
        <div class="comments-box" id="comments-${post.id}"></div>
    </div>`;
}

async function toggleLike(postId, btn) {
    const res = await fetch(`/api/post/${postId}/like`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id })
    });
    const data = await res.json();
    if (data.success) {
        btn.classList.toggle('liked', data.liked);
        btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
        btn.querySelector('.like-count').textContent = data.likes;
    }
}

async function toggleComments(postId, btn) {
    const box = document.getElementById(`comments-${postId}`);
    box.classList.toggle('open');
    if (box.classList.contains('open') && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        const res = await fetch(`/api/post/${postId}/comments`);
        const comments = await res.json();
        box.innerHTML = (comments.map(c => `
            <div class="comment-item"><img src="${c.avatar || defaultAvatar(c.name)}"><span><b>${c.name}</b>: ${escapeHtml(c.text)}</span></div>
        `).join('') || '') + `
            <div class="comment-form">
                <input type="text" id="commentInput-${postId}" placeholder="کامنت بنویس...">
                <button class="btn-secondary" onclick="submitComment('${postId}')">ارسال</button>
            </div>`;
    }
}

async function submitComment(postId) {
    const input = document.getElementById(`commentInput-${postId}`);
    const text = input.value.trim();
    if (!text) return;
    const res = await fetch(`/api/post/${postId}/comment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, text })
    });
    const data = await res.json();
    if (data.success) {
        input.value = '';
        const box = document.getElementById(`comments-${postId}`);
        const form = box.querySelector('.comment-form');
        const item = document.createElement('div');
        item.className = 'comment-item';
        item.innerHTML = `<img src="${data.comment.avatar || defaultAvatar(data.comment.name)}"><span><b>${data.comment.name}</b>: ${escapeHtml(data.comment.text)}</span>`;
        box.insertBefore(item, form);
        const card = document.querySelector(`[data-post-id="${postId}"] .comment-count`);
        if (card) card.textContent = parseInt(card.textContent) + 1;
    }
}

function updateBoostBadge(level) {
    const badge = document.getElementById('boostBadge');
    const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
    badge.textContent = labels[level] || 'عادی';
    badge.className = 'boost-badge boost-' + level;
}

// ============================================
// دستیار
// ============================================
async function loadAssistantData() {
    const res = await fetch(`/api/assistant/${currentUser.id}`);
    const data = await res.json();

    document.getElementById('statPosts').textContent = data.stats?.totalPosts ?? 0;
    document.getElementById('statTrainings').textContent = data.stats?.totalTrainings ?? 0;
    document.getElementById('statFollowers').textContent = data.stats?.followers ?? 0;
    document.getElementById('statEngagement').textContent = data.stats?.engagementRate ?? '0%';

    document.getElementById('qaList').innerHTML = data.qa?.length ? data.qa.map(q => `
        <div class="qa-item"><span>❓ ${escapeHtml(q.question)}</span><span>💬 ${escapeHtml(q.answer)}</span></div>
    `).join('') : '<p class="empty-state">هنوز آموزشی ثبت نشده.</p>';

    document.getElementById('keywordList').innerHTML = data.keywords?.length ? data.keywords.map(k => `
        <div class="keyword-item"><span>🔑 ${escapeHtml(k.keyword)}</span><span>💬 ${escapeHtml(k.response)}</span></div>
    `).join('') : '<p class="empty-state">هنوز کلمه کلیدی ثبت نشده.</p>';
}

async function trainAssistant() {
    const question = document.getElementById('questionInput').value.trim();
    const answer = document.getElementById('answerInput').value.trim();
    if (!question || !answer) { alert('سوال و جواب رو کامل کن!'); return; }

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
        loadAssistantData();
    }
}

async function trainKeyword() {
    const keyword = document.getElementById('keywordInput').value.trim();
    const response = document.getElementById('keywordResponseInput').value.trim();
    if (!keyword || !response) { alert('کلمه کلیدی و پاسخ رو کامل کن!'); return; }

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
        loadAssistantData();
    }
}

function showAutoPostPanel() {
    const panel = document.getElementById('autoPostPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

async function schedulePosts() {
    const count = parseInt(document.getElementById('postCount').value);
    const descriptions = document.getElementById('postDescriptions').value.split('\n').filter(s => s.trim());
    const time = document.getElementById('postTime').value;
    if (!count || count < 1) { alert('تعداد پست‌ها رو مشخص کن!'); return; }
    if (descriptions.length < count) { alert(`حداقل ${count} توضیح وارد کن.`); return; }

    const res = await fetch('/api/assistant/schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, postCount: count, descriptions: descriptions.slice(0, count), time })
    });
    const data = await res.json();
    if (data.success) { showNotification(`✅ ${count} پست زمان‌بندی شد`); }
}

async function testAssistant() {
    const input = document.getElementById('assistantPreviewInput');
    const msg = input.value.trim();
    if (!msg) return;
    appendMiniMsg('assistantPreviewChat', msg, 'me');
    input.value = '';

    const res = await fetch(`/api/assistant/chat/${currentUser.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    appendMiniMsg('assistantPreviewChat', data.reply, 'bot');
}

function appendMiniMsg(containerId, text, who) {
    const c = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'mini-msg ' + who;
    div.textContent = text;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
}

// ============================================
// اکسپلور
// ============================================
async function loadExplore() {
    const res = await fetch('/api/explore');
    const items = await res.json();
    const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
    document.getElementById('exploreContent').innerHTML = items.length ? items.map(c => `
        <div class="explore-card" onclick="openProfile('${c.user_id}')">
            <img src="${c.avatar || defaultAvatar(c.name)}">
            <h4>${c.name}</h4>
            <div class="meta">${labels[c.boost_level] || 'عادی'} · ${c.followers_count} فالوور</div>
            <button class="follow-btn" onclick="event.stopPropagation(); quickFollow('${c.user_id}', this)">فالو</button>
        </div>`).join('') : '<p class="empty-state">هنوز کانالی وجود نداره.</p>';
}

async function quickFollow(userId, btn) {
    if (userId === currentUser.id) return;
    const res = await fetch('/api/follow', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followerId: currentUser.id, followingId: userId })
    });
    const data = await res.json();
    if (data.success) { btn.textContent = 'فالو شد'; btn.classList.add('following'); }
}

// ============================================
// پروفایل عمومی (بازدید از پروفایل دیگران)
// ============================================
async function openProfile(userId) {
    viewingProfileId = userId;
    const res = await fetch(`/api/profile/${userId}?viewerId=${currentUser.id}`);
    const data = await res.json();

    document.getElementById('viewAvatar').src = data.user.avatar || defaultAvatar(data.user.name);
    document.getElementById('viewName').textContent = data.user.name;
    document.getElementById('viewFollowers').textContent = data.channel?.followers_count || 0;
    document.getElementById('viewPosts').textContent = data.channel?.posts_count || 0;
    document.getElementById('viewScore').textContent = data.user.score || 0;

    viewingProfileFollowing = data.isFollowing;
    const followBtn = document.getElementById('viewFollowBtn');
    followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';

    document.getElementById('viewPostsContainer').innerHTML = data.posts.length ?
        data.posts.map(p => renderPostCard(p, data.user)).join('') :
        '<p class="empty-state">هنوز پستی منتشر نکرده.</p>';

    document.getElementById('viewAssistantChat').innerHTML = '';

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('profilePage').classList.add('active');
}

function backFromProfile() {
    document.querySelector('[data-page="explore"]').click();
}

async function toggleFollowView() {
    const endpoint = viewingProfileFollowing ? '/api/unfollow' : '/api/follow';
    const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followerId: currentUser.id, followingId: viewingProfileId })
    });
    const data = await res.json();
    if (data.success) {
        viewingProfileFollowing = !viewingProfileFollowing;
        document.getElementById('viewFollowBtn').textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
        const count = document.getElementById('viewFollowers');
        count.textContent = parseInt(count.textContent) + (viewingProfileFollowing ? 1 : -1);
    }
}

async function askOtherAssistant() {
    const input = document.getElementById('viewAssistantInput');
    const msg = input.value.trim();
    if (!msg || !viewingProfileId) return;
    appendMiniMsg('viewAssistantChat', msg, 'me');
    input.value = '';

    const res = await fetch(`/api/assistant/chat/${viewingProfileId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    appendMiniMsg('viewAssistantChat', data.reply, 'bot');
}

function openChatFromProfile() {
    document.querySelector('[data-page="chat"]').click();
    openChat(viewingProfileId, document.getElementById('viewName').textContent, document.getElementById('viewAvatar').src);
}

// ============================================
// چت خصوصی
// ============================================
async function loadChatList() {
    const res = await fetch(`/api/chat/list/${currentUser.id}`);
    const chats = await res.json();
    document.getElementById('chatList').innerHTML = chats.length ? chats.map(c => `
        <div class="chat-item" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
            <img src="${c.avatar || defaultAvatar(c.name)}">
            <div><strong>${c.name}</strong><p style="font-size:11.5px;color:var(--text-2);">${escapeHtml(c.lastMessage || '')}</p></div>
        </div>`).join('') : '<p class="empty-state">هنوز چتی نداری. از اکسپلور یکی رو پیدا کن و پیام بده!</p>';
}

async function openChat(userId, name, avatar) {
    currentChatUser = { id: userId, name, avatar };
    document.getElementById('chatWithName').textContent = name || 'کاربر';
    document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
    document.getElementById('chatWindow').classList.add('open');
    document.getElementById('chatMessages').innerHTML = '';

    const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
    const messages = await res.json();
    const container = document.getElementById('chatMessages');
    container.innerHTML = messages.map(m => `<div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'}">${escapeHtml(m.message)}</div>`).join('');
    container.scrollTop = container.scrollHeight;
}

function closeChatWindow() {
    document.getElementById('chatWindow').classList.remove('open');
    currentChatUser = null;
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !currentChatUser) return;

    socket.emit('private_message', { from: currentUser.id, to: currentChatUser.id, message, timestamp: Date.now() });
    displayMessage(message, 'sent');
    input.value = '';
}

function displayMessage(text, type) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

socket.on('new_message', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
        displayMessage(data.message, 'received');
    } else {
        showNotification(`📩 پیام جدید`);
    }
});

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const q = e.target.value.trim();
    if (q.length < 2) return;
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    console.log('نتایج جستجو:', results);
}, 450));

// ============================================
// توابع کمکی
// ============================================
function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function showNotification(text) {
    const n = document.createElement('div');
    n.className = 'notification';
    n.textContent = text;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2600);
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
    if (diff < 60) return 'همین الان';
    if (diff < 3600) return Math.floor(diff / 60) + ' دقیقه پیش';
    if (diff < 86400) return Math.floor(diff / 3600) + ' ساعت پیش';
    return Math.floor(diff / 86400) + ' روز پیش';
}

initApp();
