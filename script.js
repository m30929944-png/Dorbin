// ============================================
// اتصال WebSocket
// ============================================
const socket = io({ 
    transports: ['websocket', 'polling'], 
    reconnection: true, 
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 10000
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

// ============================================
// توابع اصلی
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
    return Math.floor(diff / 86400) + ' روز پیش';
}

function showNotification(text) {
    const n = document.createElement('div');
    n.className = 'notification';
    n.textContent = text;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2600);
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
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
}

function updateBoostBadge(level) {
    const badge = document.getElementById('boostBadge');
    if (!badge) return;
    const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
    badge.textContent = labels[level] || 'عادی';
    badge.className = 'boost-badge boost-' + level;
}

// ============================================
// ورود / ثبت‌نام
// ============================================
async function initApp() {
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
            <div class="avatar-upload">
                <img id="regAvatarPreview" src="${defaultAvatar('guest')}">
                <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
            </div>
            <input type="text" id="regNameInput" class="name-input" placeholder="اسمت چیه؟" maxlength="30">
            <button class="btn-primary" style="width:100%;padding:10px;" onclick="registerUser()">ورود به یارِ من</button>
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
            afterLogin();
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

function afterLogin() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('userScore').textContent = `🏆 ${currentUser.score || 0}`;
    socket.emit('join', currentUser.id);
    setupNav();
    loadPageData('channel');
    
    socket.on('broadcast', (data) => {
        showNotification(`📢 ${data.title || 'اعلان'}: ${data.message}`);
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
            <h3 style="font-size:16px;">${escapeHtml(currentUser.name)}</h3>
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
        readFileAsBase64(e.target.files[0], async (b64) => {
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
        content.innerHTML = `<video src="${b64}" controls></video>`;
    } else {
        content.innerHTML = `<img src="${b64}">`;
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
        const res = await fetch(`/api/channel/${currentUser.id}/posts`);
        const posts = await res.json();
        const container = document.getElementById('channelPosts');
        if (!container) return;
        
        container.innerHTML = posts.length ? 
            posts.map(p => renderPostCard(p, currentUser)).join('') :
            '<p class="empty-state">هنوز پستی منتشر نکردی. اولین پستت رو بنویس! ✍️</p>';

        const ures = await fetch(`/api/user/${currentUser.id}`);
        const u = await ures.json();
        document.getElementById('followersCount').textContent = `${u.followers || 0} فالوور`;
    } catch (e) { console.error(e); }
}

function renderPostCard(post, author) {
    const name = author?.name || post.channel_name || 'کاربر';
    const avatar = author?.avatar || defaultAvatar(name);
    const mediaHtml = post.media_url ? `
        <div class="media-wrapper">
            ${post.media_type === 'video' ? 
                `<video src="${post.media_url}" controls></video>` : 
                `<img src="${post.media_url}" loading="lazy">`}
        </div>` : '';
    
    return `
    <div class="post-card" data-post-id="${post.id}">
        <div class="post-head" onclick="openProfile('${post.user_id || currentUser.id}')">
            <img src="${avatar}">
            <span class="name">${escapeHtml(name)}</span>
            <span class="time">${timeAgo(post.created_at)}</span>
        </div>
        <p class="content">${escapeHtml(post.content)}</p>
        ${mediaHtml}
        <div class="post-stats">
            <button onclick="toggleLike('${post.id}', this)"><i class="far fa-heart"></i> <span class="like-count">${post.likes || 0}</span></button>
            <button onclick="toggleComments('${post.id}', this)"><i class="far fa-comment"></i> <span class="comment-count">${post.comments || 0}</span></button>
            <button disabled><i class="far fa-eye"></i> ${post.views || 0}</button>
        </div>
        <div class="comments-box" id="comments-${post.id}"></div>
    </div>`;
}

async function toggleLike(postId, btn) {
    try {
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
    } catch (e) { showNotification('خطا'); }
}

async function toggleComments(postId, btn) {
    const box = document.getElementById(`comments-${postId}`);
    if (!box) return;
    box.classList.toggle('open');
    if (box.classList.contains('open') && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        try {
            const res = await fetch(`/api/post/${postId}/comments`);
            const comments = await res.json();
            box.innerHTML = (comments.map(c => `
                <div class="comment-item"><img src="${c.avatar || defaultAvatar(c.name)}"><span><b>${escapeHtml(c.name)}</b>: ${escapeHtml(c.text)}</span></div>
            `).join('') || '') + `
                <div class="comment-form">
                    <input type="text" id="commentInput-${postId}" placeholder="کامنت بنویس...">
                    <button class="btn-secondary" onclick="submitComment('${postId}')">ارسال</button>
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
            const form = box.querySelector('.comment-form');
            const item = document.createElement('div');
            item.className = 'comment-item';
            item.innerHTML = `<img src="${data.comment.avatar || defaultAvatar(data.comment.name)}"><span><b>${escapeHtml(data.comment.name)}</b>: ${escapeHtml(data.comment.text)}</span>`;
            box.insertBefore(item, form);
            const card = document.querySelector(`[data-post-id="${postId}"] .comment-count`);
            if (card) card.textContent = parseInt(card.textContent) + 1;
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

        if (data.posts?.length) {
            document.getElementById('scheduledPostsList').innerHTML = data.posts.map(p => `
                <div style="font-size:11px;color:var(--text-2);padding:4px 0;border-bottom:1px solid var(--border);">
                    📅 ${escapeHtml(p.content?.substring(0, 30) || '')}... - ${new Date(p.scheduled_time).toLocaleString('fa-IR')}
                </div>
            `).join('');
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

function toggleAutoPost() {
    const panel = document.getElementById('autoPostPanel');
    if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    }
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
// زمان‌بندی پست‌ها
// ============================================
document.getElementById('scheduleImages').addEventListener('change', function(e) {
    for (const file of e.target.files) {
        readFileAsBase64(file, (b64) => {
            scheduledMediaFiles.push({ data: b64, type: 'image' });
        });
    }
});

document.getElementById('scheduleVideos').addEventListener('change', function(e) {
    for (const file of e.target.files) {
        readFileAsBase64(file, (b64) => {
            scheduledMediaFiles.push({ data: b64, type: 'video' });
        });
    }
});

async function schedulePosts() {
    const count = parseInt(document.getElementById('postCount').value);
    const descriptions = document.getElementById('postDescriptions').value.split('\n').filter(s => s.trim());
    const time = document.getElementById('postTime').value;
    const interval = parseInt(document.getElementById('postInterval').value) || 1;

    if (!count || count < 1) { showNotification('تعداد پست‌ها رو مشخص کن!'); return; }
    if (descriptions.length < count) { showNotification(`حداقل ${count} توضیح وارد کن.`); return; }

    const posts = [];
    const baseDate = new Date();
    const [hours, minutes] = time.split(':').map(Number);
    baseDate.setHours(hours || 9, minutes || 0, 0, 0);

    for (let i = 0; i < count; i++) {
        const postDate = new Date(baseDate);
        postDate.setDate(postDate.getDate() + (i * interval));
        
        const media = scheduledMediaFiles[i] || null;
        posts.push({
            content: descriptions[i] || `پست شماره ${i + 1}`,
            scheduledTime: postDate.toISOString(),
            mediaUrl: media ? media.data : null,
            mediaType: media ? media.type : 'none'
        });
    }

    try {
        const res = await fetch('/api/assistant/schedule', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, posts })
        });
        const data = await res.json();
        if (data.success) {
            showNotification(`✅ ${count} پست زمان‌بندی شد`);
            scheduledMediaFiles = [];
            document.getElementById('scheduleImages').value = '';
            document.getElementById('scheduleVideos').value = '';
            await loadAssistantData();
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

// ============================================
// اکسپلور
// ============================================
async function loadExplore() {
    try {
        const res = await fetch('/api/explore');
        const items = await res.json();
        const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
        const container = document.getElementById('exploreContent');
        if (!container) return;
        
        container.innerHTML = items.length ? items.map(c => `
            <div class="explore-card" onclick="openProfile('${c.user_id}')">
                <img src="${c.avatar || defaultAvatar(c.user_name || c.name)}" loading="lazy">
                <h4>${escapeHtml(c.user_name || c.name)}</h4>
                <div class="meta">${labels[c.boost_level] || 'عادی'} · ${c.followers_count} فالوور</div>
                <button class="follow-btn" onclick="event.stopPropagation(); quickFollow('${c.user_id}', this)">فالو</button>
            </div>`).join('') : '<p class="empty-state">هنوز کانالی وجود نداره.</p>';
    } catch (e) { console.error(e); }
}

async function quickFollow(userId, btn) {
    if (userId === currentUser.id) return;
    try {
        const res = await fetch('/api/follow', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ followerId: currentUser.id, followingId: userId })
        });
        const data = await res.json();
        if (data.success) { 
            btn.textContent = 'فالو شد'; 
            btn.classList.add('following');
            showNotification('✅ فالو شد');
        }
    } catch (e) { showNotification('خطا'); }
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
        document.getElementById('viewFollowers').textContent = data.channel?.followers_count || 0;
        document.getElementById('viewPosts').textContent = data.channel?.posts_count || 0;
        document.getElementById('viewScore').textContent = data.user.score || 0;

        viewingProfileFollowing = data.isFollowing;
        const followBtn = document.getElementById('viewFollowBtn');
        if (followBtn) followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';

        const container = document.getElementById('viewPostsContainer');
        if (container) {
            container.innerHTML = data.posts.length ?
                data.posts.map(p => renderPostCard(p, data.user)).join('') :
                '<p class="empty-state">هنوز پستی منتشر نکرده.</p>';
        }

        document.getElementById('viewAssistantChat').innerHTML = '';

        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const profilePage = document.getElementById('profilePage');
        if (profilePage) profilePage.classList.add('active');
    } catch (e) { showNotification('خطا'); }
}

function backFromProfile() {
    document.querySelector('[data-page="explore"]').click();
}

async function toggleFollowView() {
    if (!viewingProfileId) return;
    const endpoint = viewingProfileFollowing ? '/api/unfollow' : '/api/follow';
    try {
        const res = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ followerId: currentUser.id, followingId: viewingProfileId })
        });
        const data = await res.json();
        if (data.success) {
            viewingProfileFollowing = !viewingProfileFollowing;
            const followBtn = document.getElementById('viewFollowBtn');
            if (followBtn) followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
            const count = document.getElementById('viewFollowers');
            if (count) count.textContent = parseInt(count.textContent) + (viewingProfileFollowing ? 1 : -1);
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
        
        container.innerHTML = chats.length ? chats.map(c => `
            <div class="chat-item" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
                <img src="${c.avatar || defaultAvatar(c.name)}">
                <div><strong>${escapeHtml(c.name)}</strong><p>${escapeHtml(c.lastMessage || '')}</p></div>
            </div>`).join('') : '<p class="empty-state">هنوز چتی نداری. از اکسپلور یکی رو پیدا کن و پیام بده!</p>';
    } catch (e) { console.error(e); }
}

async function openChat(userId, name, avatar) {
    currentChatUser = { id: userId, name, avatar };
    document.getElementById('chatWithName').textContent = name || 'کاربر';
    document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
    document.getElementById('chatWindow').classList.add('open');
    document.getElementById('chatMessages').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> بارگذاری...</div>';

    try {
        const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
        const messages = await res.json();
        const container = document.getElementById('chatMessages');
        container.innerHTML = messages.map(m => `<div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'}">${escapeHtml(m.message)}</div>`).join('');
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

    socket.emit('private_message', { from: currentUser.id, to: currentChatUser.id, message, timestamp: Date.now() });
    displayMessage(message, 'sent');
    input.value = '';
}

function displayMessage(text, type) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
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
// پنل مدیریت
// ============================================
function toggleAdminPanel() {
    if (!isAdmin) return;
    adminPanelOpen = !adminPanelOpen;
    if (adminPanelOpen) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const adminPage = document.getElementById('adminPage');
        if (adminPage) adminPage.classList.add('active');
        loadAdminData('users');
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
        if (type === 'users') {
            const res = await fetch('/api/admin/users', { 
                method: 'GET',
                headers: { 'userId': 'admin_milad' }
            });
            const users = await res.json();
            const container = document.getElementById('adminUsersList');
            if (container) {
                container.innerHTML = users.map(u => `
                    <div class="admin-user-item">
                        <span class="name">${escapeHtml(u.name)}</span>
                        <span style="font-size:10px;color:var(--text-3);">${u.role || 'user'}</span>
                        <div class="actions">
                            ${u.role !== 'admin' ? `
                                <button class="btn-secondary" onclick="adminAction('user','${u.id}','verify')">تأیید</button>
                                <button class="btn-danger" onclick="adminAction('user','${u.id}','ban')">بن</button>
                            ` : ''}
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
                    <div class="admin-post-item">
                        <span>${escapeHtml(p.content?.substring(0, 30) || '')}...</span>
                        <span style="font-size:10px;color:var(--text-3);">${escapeHtml(p.user_name)}</span>
                        <button class="btn-danger" onclick="adminAction('post','${p.id}','delete')">حذف</button>
                    </div>
                `).join('');
            }
        } else if (type === 'channels') {
            const res = await fetch('/api/admin/channels', { headers: { 'userId': 'admin_milad' } });
            const channels = await res.json();
            const container = document.getElementById('adminChannelsList');
            if (container) {
                container.innerHTML = channels.map(c => `
                    <div class="admin-user-item">
                        <span>${escapeHtml(c.name)}</span>
                        <span style="font-size:10px;color:var(--text-3);">${c.followers_count} فالوور</span>
                        <span style="font-size:10px;color:var(--text-3);">${c.boost_level}</span>
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
            body: JSON.stringify({ title: title || 'اعلان سیستمی', message })
        });
        const data = await res.json();
        if (data.success) {
            showNotification(`✅ ${data.message}`);
            document.getElementById('broadcastTitle').value = '';
            document.getElementById('broadcastMessage').value = '';
        }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const q = e.target.value.trim();
    if (q.length < 2) return;
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const results = await res.json();
        console.log('نتایج جستجو:', results);
    } catch (e) { console.error(e); }
}, 450));

function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ============================================
// شروع برنامه
// ============================================
document.addEventListener('DOMContentLoaded', initApp);