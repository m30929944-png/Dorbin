// =============================================
// متغیرهای جهانی
// =============================================
let currentUser = null;
let currentPostId = null;
let currentChatUser = null;
let token = null;
let socket = null;

// =============================================
// احراز هویت
// =============================================
function showRegister() {
    document.getElementById('loginPage').classList.remove('active');
    document.getElementById('registerPage').classList.add('active');
}

function showLogin() {
    document.getElementById('registerPage').classList.remove('active');
    document.getElementById('loginPage').classList.add('active');
}

async function register() {
    const username = document.getElementById('regUsername').value.trim();
    const name = document.getElementById('regName').value.trim();
    const password = document.getElementById('regPassword').value;
    const errorEl = document.getElementById('regError');

    if (!username || !password) {
        errorEl.textContent = 'لطفاً همه فیلدها را پر کنید';
        return;
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, name })
        });
        const data = await res.json();

        if (data.error) {
            errorEl.textContent = data.error;
            return;
        }

        token = data.token;
        currentUser = data;
        localStorage.setItem('token', token);
        initApp();
    } catch {
        errorEl.textContent = 'خطا در ارتباط با سرور';
    }
}

async function login() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    if (!username || !password) {
        errorEl.textContent = 'لطفاً همه فیلدها را پر کنید';
        return;
    }

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.error) {
            errorEl.textContent = data.error;
            return;
        }

        token = data.token;
        currentUser = data;
        localStorage.setItem('token', token);
        initApp();
    } catch {
        errorEl.textContent = 'خطا در ارتباط با سرور';
    }
}

function logout() {
    localStorage.removeItem('token');
    token = null;
    currentUser = null;
    if (socket) socket.disconnect();
    document.getElementById('appPage').classList.remove('active');
    document.getElementById('loginPage').classList.add('active');
}

function checkAuth() {
    token = localStorage.getItem('token');
    if (token) {
        initApp();
    } else {
        document.getElementById('loginPage').classList.add('active');
    }
}

// =============================================
// مقداردهی اولیه
// =============================================
async function initApp() {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('appPage').classList.add('active');

    // دریافت اطلاعات کاربر
    try {
        const res = await fetch('/api/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        currentUser = await res.json();
        console.log('👤 کاربر:', currentUser.username);
    } catch {
        alert('خطا در دریافت اطلاعات');
        logout();
        return;
    }

    // اتصال Socket.io
    socket = io();
    socket.emit('auth', currentUser._id);

    socket.on('new_story', (data) => {
        loadStories();
    });

    socket.on('new_message', (data) => {
        if (currentChatUser === data.senderId) {
            loadChatMessages();
        }
    });

    // بارگذاری اولیه
    loadPosts();
    loadStories();
}

// =============================================
// پست‌ها
// =============================================
async function loadPosts() {
    try {
        const res = await fetch('/api/posts', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const posts = await res.json();
        renderPosts(posts);
    } catch {
        showToast('خطا در بارگذاری پست‌ها');
    }
}

function renderPosts(posts) {
    const container = document.getElementById('mainContent');
    if (!posts || posts.length === 0) {
        container.innerHTML = `
            <div style="text-align:center;padding:50px;color:#999;">
                <i class="fas fa-camera" style="font-size:48px;"></i>
                <p>هنوز پستی وجود ندارد</p>
                <p style="font-size:14px;">اولین پست خود را منتشر کنید!</p>
            </div>
        `;
        return;
    }

    let html = '';
    posts.forEach(post => {
        const isLiked = post.isLiked ? 'liked' : '';
        const comments = post.comments || [];
        const commentsHtml = comments.slice(0, 2).map(c => `
            <div class="comment-item">
                <strong>${c.userId?.username || 'کاربر'}</strong> ${c.text}
                ${c.replies && c.replies.length > 0 ? 
                    `<div style="margin-right:20px;font-size:12px;color:#999;">
                        ${c.replies.map(r => `<div><strong>${r.userId?.username || 'کاربر'}</strong> ${r.text}</div>`).join('')}
                    </div>` : ''}
            </div>
        `).join('');

        html += `
            <div class="post-card">
                <div class="post-header">
                    <div class="avatar">
                        <img src="${post.userId?.avatar || 'default.png'}" alt="آواتار">
                    </div>
                    <span class="username">${post.userId?.username || 'کاربر ناشناس'}</span>
                    <span class="time">${new Date(post.createdAt).toLocaleDateString('fa-IR')}</span>
                </div>
                <img src="${post.image}" class="post-image" alt="پست">
                <div class="post-actions">
                    <i class="fas fa-heart ${isLiked}" onclick="toggleLike('${post._id}')"></i>
                    <i class="fas fa-comment" onclick="openComments('${post._id}')"></i>
                    <i class="fas fa-share" onclick="sharePost('${post._id}')"></i>
                </div>
                <div class="post-likes">${post.likesCount || 0} لایک</div>
                <div class="post-caption">
                    <strong>${post.userId?.username || ''}</strong> ${post.caption || ''}
                    ${post.hashtags?.map(h => `<span class="hashtag">#${h}</span>`).join(' ') || ''}
                </div>
                ${commentsHtml ? `<div class="post-comments">${commentsHtml}</div>` : ''}
                <div class="comment-input-wrap">
                    <input type="text" placeholder="نظر خود را بنویسید..." id="commentInput_${post._id}">
                    <button onclick="addComment('${post._id}')">ارسال</button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// =============================================
// لایک
// =============================================
async function toggleLike(postId) {
    try {
        const res = await fetch(`/api/like/${postId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        loadPosts(); // رفرش
    } catch {
        showToast('خطا در لایک');
    }
}

// =============================================
// کامنت
// =============================================
async function addComment(postId) {
    const input = document.getElementById(`commentInput_${postId}`);
    const text = input.value.trim();
    if (!text) return;

    try {
        await fetch(`/api/comment/${postId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text })
        });
        input.value = '';
        loadPosts();
    } catch {
        showToast('خطا در ارسال کامنت');
    }
}

function openComments(postId) {
    currentPostId = postId;
    loadComments();
}

async function loadComments() {
    try {
        const res = await fetch(`/api/posts`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const posts = await res.json();
        const post = posts.find(p => p._id === currentPostId);
        if (!post) return;

        const container = document.getElementById('commentsList');
        let html = '';
        post.comments.forEach(c => {
            html += `
                <div class="comment-item">
                    <strong>${c.userId?.username || 'کاربر'}</strong> ${c.text}
                    <button onclick="replyToComment('${post._id}','${c._id}')" style="font-size:12px;background:none;border:none;color:#405DE6;cursor:pointer;">
                        پاسخ
                    </button>
                </div>
            `;
        });
        container.innerHTML = html || 'هیچ نظری ثبت نشده است';
        document.getElementById('commentModal').classList.add('active');
    } catch {
        showToast('خطا در بارگذاری کامنت‌ها');
    }
}

async function sendComment() {
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !currentPostId) return;

    await addComment(currentPostId);
    input.value = '';
    loadComments();
}

async function replyToComment(postId, commentId) {
    const text = prompt('پاسخ خود را بنویسید:');
    if (!text) return;

    try {
        await fetch(`/api/reply/${postId}/${commentId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text })
        });
        loadComments();
        showToast('پاسخ ارسال شد');
    } catch {
        showToast('خطا در ارسال پاسخ');
    }
}

// =============================================
// اشتراک گذاری
// =============================================
function sharePost(postId) {
    const url = `${window.location.origin}/post/${postId}`;
    if (navigator.share) {
        navigator.share({ title: 'پست ساده‌گرام', url });
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showToast('لینک پست کپی شد');
        });
    }
}

// =============================================
// استوری
// =============================================
async function loadStories() {
    try {
        const res = await fetch('/api/stories', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const stories = await res.json();
        renderStories(stories);
    } catch {
        console.error('خطا در استوری');
    }
}

function renderStories(stories) {
    const container = document.getElementById('storiesContainer');
    let html = `
        <div class="story-add" onclick="addStory()">
            <div class="story-avatar"><i class="fas fa-plus"></i></div>
            <span>استوری</span>
        </div>
    `;

    stories.forEach(s => {
        html += `
            <div class="story-item" onclick="viewStory('${s._id}')">
                <div class="story-avatar" style="${s.viewed ? 'border-color:#999;' : ''}">
                    <img src="${s.userId?.avatar || 'default.png'}" alt="استوری">
                </div>
                <span>${s.userId?.username || ''}</span>
            </div>
        `;
    });

    container.innerHTML = html;
}

function addStory() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('story', file);

        try {
            await fetch('/api/story', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            showToast('استوری منتشر شد');
            loadStories();
        } catch {
            showToast('خطا در انتشار استوری');
        }
    };
    input.click();
}

async function viewStory(storyId) {
    try {
        await fetch(`/api/view-story/${storyId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        loadStories();
        showToast('استوری مشاهده شد');
    } catch {
        showToast('خطا');
    }
}

// =============================================
// آپلود پست
// =============================================
function openUpload() {
    document.getElementById('uploadModal').classList.add('active');
}

async function uploadPost() {
    const fileInput = document.getElementById('fileInput');
    const caption = document.getElementById('captionInput').value.trim();
    const hashtags = document.getElementById('hashtagInput').value.trim();

    if (!fileInput.files[0]) {
        showToast('لطفاً یک فایل انتخاب کنید');
        return;
    }

    const formData = new FormData();
    formData.append('image', fileInput.files[0]);
    formData.append('caption', caption);
    formData.append('hashtags', hashtags);

    try {
        const res = await fetch('/api/post', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            showToast('پست با موفقیت منتشر شد');
            closeModal('uploadModal');
            document.getElementById('fileInput').value = '';
            document.getElementById('captionInput').value = '';
            document.getElementById('hashtagInput').value = '';
            loadPosts();
        } else {
            showToast(data.error || 'خطا');
        }
    } catch {
        showToast('خطا در آپلود');
    }
}

// =============================================
// پروفایل
// =============================================
async function loadProfile() {
    try {
        const res = await fetch('/api/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const user = await res.json();

        const container = document.getElementById('profileContent');
        container.innerHTML = `
            <div style="text-align:center;">
                <div style="width:100px;height:100px;border-radius:50%;overflow:hidden;margin:0 auto;border:3px solid #405DE6;">
                    <img src="${user.avatar}" style="width:100%;height:100%;object-fit:cover;">
                </div>
                <h3>${user.username}</h3>
                <p>${user.name || ''}</p>
                <p style="color:#666;">${user.bio || 'بیوگرافی خود را بنویسید...'}</p>
                <div style="display:flex;justify-content:center;gap:20px;margin:15px 0;">
                    <div><strong>${user.postsCount || 0}</strong><br>پست</div>
                    <div><strong>${user.followers?.length || 0}</strong><br>فالوور</div>
                    <div><strong>${user.following?.length || 0}</strong><br>فالوینگ</div>
                </div>
                <button onclick="editBio()" style="padding:8px 20px;border:none;border-radius:10px;background:#405DE6;color:white;cursor:pointer;">
                    ویرایش بیو
                </button>
                <button onclick="changeAvatar()" style="padding:8px 20px;border:none;border-radius:10px;background:#E1306C;color:white;cursor:pointer;margin-right:10px;">
                    تغییر عکس
                </button>
            </div>
            <hr style="margin:15px 0;">
            <div id="userPosts" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;"></div>
        `;

        // بارگذاری پست‌های کاربر
        const postsRes = await fetch(`/api/user-posts/${user._id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const userPosts = await postsRes.json();

        const postsContainer = document.getElementById('userPosts');
        if (userPosts.length === 0) {
            postsContainer.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#999;">هیچ پستی وجود ندارد</p>';
        } else {
            userPosts.forEach(p => {
                const div = document.createElement('div');
                div.style.cssText = 'aspect-ratio:1;overflow:hidden;border-radius:8px;cursor:pointer;';
                div.innerHTML = `<img src="${p.image}" style="width:100%;height:100%;object-fit:cover;">`;
                div.onclick = () => loadPosts();
                postsContainer.appendChild(div);
            });
        }

        document.getElementById('profileModal').classList.add('active');
    } catch {
        showToast('خطا در بارگذاری پروفایل');
    }
}

async function editBio() {
    const bio = prompt('بیوگرافی جدید:');
    if (bio === null) return;

    try {
        await fetch('/api/bio', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ bio })
        });
        showToast('بیوگرافی ذخیره شد');
        loadProfile();
    } catch {
        showToast('خطا');
    }
}

function changeAvatar() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('avatar', file);

        try {
            await fetch('/api/avatar', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            showToast('عکس پروفایل تغییر کرد');
            loadProfile();
        } catch {
            showToast('خطا');
        }
    };
    input.click();
}

// =============================================
// چت
// =============================================
function toggleChat() {
    if (document.getElementById('chatModal').classList.contains('active')) {
        closeModal('chatModal');
    } else {
        const userId = prompt('شناسه کاربر مورد نظر:');
        if (userId) {
            currentChatUser = userId;
            document.getElementById('chatModal').classList.add('active');
            loadChatMessages();
        }
    }
}

async function loadChatMessages() {
    if (!currentChatUser) return;

    try {
        const res = await fetch(`/api/messages/${currentChatUser}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const messages = await res.json();

        const container = document.getElementById('chatMessages');
        let html = '';
        messages.forEach(m => {
            const isMe = m.senderId === currentUser._id;
            html += `
                <div style="text-align:${isMe ? 'right' : 'left'};margin:5px 0;">
                    <div style="background:${isMe ? '#405DE6' : '#f0f0f0'};color:${isMe ? 'white' : '#333'};
                        padding:8px 14px;border-radius:15px;display:inline-block;max-width:70%;">
                        ${m.text}
                        <div style="font-size:10px;opacity:0.6;">${new Date(m.createdAt).toLocaleTimeString('fa-IR')}</div>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html || 'هیچ پیامی وجود ندارد';
        container.scrollTop = container.scrollHeight;
    } catch {
        showToast('خطا در بارگذاری پیام‌ها');
    }
}

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !currentChatUser) return;

    try {
        await fetch('/api/message', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ receiverId: currentChatUser, text })
        });
        input.value = '';
        loadChatMessages();
    } catch {
        showToast('خطا در ارسال پیام');
    }
}

// =============================================
// جستجو
// =============================================
async function search(query) {
    if (query.length < 2) {
        document.getElementById('mainContent').innerHTML = '';
        loadPosts();
        return;
    }

    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        let html = `<div style="padding:10px;">`;

        if (data.users && data.users.length > 0) {
            html += `<h4>کاربران</h4>`;
            data.users.forEach(u => {
                html += `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #eee;cursor:pointer;"
                        onclick="viewUserProfile('${u._id}')">
                        <img src="${u.avatar || 'default.png'}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">
                        <div><strong>${u.username}</strong><br><span style="font-size:12px;color:#999;">${u.name || ''}</span></div>
                    </div>
                `;
            });
        }

        if (data.posts && data.posts.length > 0) {
            html += `<h4>پست‌ها</h4>`;
            data.posts.forEach(p => {
                html += `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #eee;cursor:pointer;"
                        onclick="loadPosts()">
                        <img src="${p.image}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;">
                        <div><strong>${p.userId?.username || ''}</strong><br><span style="font-size:12px;color:#999;">${p.caption || ''}</span></div>
                    </div>
                `;
            });
        }

        if (!data.users?.length && !data.posts?.length) {
            html += `<p style="text-align:center;color:#999;padding:30px;">نتیجه‌ای یافت نشد</p>`;
        }

        html += `</div>`;
        document.getElementById('mainContent').innerHTML = html;
    } catch {
        showToast('خطا در جستجو');
    }
}

function viewUserProfile(userId) {
    window.open(`/user/${userId}`, '_blank');
}

// =============================================
// ابزارها
// =============================================
function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
        background:#1a1a2e;color:white;padding:12px 24px;border-radius:12px;
        z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,0.3);
        animation: fadeIn 0.3s ease;direction:rtl;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = '0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// =============================================
// استایل داینامیک برای Toast
// =============================================
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeIn {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
`;
document.head.appendChild(style);

// =============================================
// شروع
// =============================================
checkAuth();

// بستن مودال‌ها با کلیک خارج
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });
});

// Enter برای لاگین
document.getElementById('loginPassword').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});
document.getElementById('regPassword').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') register();
});
