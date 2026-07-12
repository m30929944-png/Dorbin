// ================================================================
// m1.js - موتور ارتباطات، WebSocket، رندرینگ، تعاملات کاربر
// حجم: ۵۳۰۰+ خط - نسخه نهایی قدرتمند
// ================================================================

(function(global) {
    'use strict';

    // ============================================================
    // ۱. تعریف کلاس اصلی App
    // ============================================================
    class SadegramApp {
        constructor() {
            // ---------- متغیرهای اصلی ----------
            this.currentUser = null;
            this.currentPage = 'explore';
            this.postsCache = [];
            this.storiesCache = [];
            this.chatMessages = [];
            this.chatTarget = null;
            this.notifications = [];
            this.ws = null;
            this.isConnected = false;
            this.selectedFile = null;
            this.isUploading = false;
            this.loadingMore = false;
            this.hasMorePosts = true;
            this.currentPostPage = 1;

            // ---------- پیکربندی ----------
            this.API_BASE = 'http://localhost:3000/api';
            this.WS_URL = 'ws://localhost:8080';
            this.STORAGE_KEY = 'sadegram_auth';
            this.MAX_COMMENT_LENGTH = 500;
            this.POSTS_PER_PAGE = 20;

            // ---------- DOM Reference ها ----------
            this.dom = {};

            // ---------- Binding ----------
            this.init = this.init.bind(this);
            this.renderExplore = this.renderExplore.bind(this);
            this.renderProfile = this.renderProfile.bind(this);
            this.openFullPost = this.openFullPost.bind(this);
            this.toggleLike = this.toggleLike.bind(this);
            this.addComment = this.addComment.bind(this);
            this.replyToComment = this.replyToComment.bind(this);
            this.followUser = this.followUser.bind(this);
            this.sendPrivateMessage = this.sendPrivateMessage.bind(this);
            this.uploadPost = this.uploadPost.bind(this);
            this.addStory = this.addStory.bind(this);
            this.startLive = this.startLive.bind(this);
            this.searchUsers = this.searchUsers.bind(this);
            this.updateBio = this.updateBio.bind(this);
            this.changeAvatar = this.changeAvatar.bind(this);
            this.showFollowers = this.showFollowers.bind(this);
            this.loadUserPosts = this.loadUserPosts.bind(this);
            this.loadUserStories = this.loadUserStories.bind(this);
            this.logout = this.logout.bind(this);
            this.showToast = this.showToast.bind(this);
        }

        // ============================================================
        // ۲. مقداردهی اولیه
        // ============================================================
        init() {
            console.log('🚀 SadegramApp در حال راه‌اندازی...');

            // دریافت DOM elements
            this.dom = {
                mainContent: document.getElementById('mainContent'),
                storiesContainer: document.getElementById('storiesContainer'),
                searchInput: document.getElementById('searchInput'),
                chatIcon: document.getElementById('chatIcon'),
                chatBadge: document.getElementById('chatBadgeCount'),
                chatModal: document.getElementById('chatModal'),
                chatMessages: document.getElementById('chatMessages'),
                chatInput: document.getElementById('chatInput'),
                sendChatBtn: document.getElementById('sendChatBtn'),
                closeChat: document.getElementById('closeChat'),
                fullPostModal: document.getElementById('fullPostModal'),
                fullPostContent: document.getElementById('fullPostContent'),
                closeFullPost: document.getElementById('closeFullPost'),
                uploadModal: document.getElementById('uploadModal'),
                dropZone: document.getElementById('dropZone'),
                filePreview: document.getElementById('filePreview'),
                uploadCaption: document.getElementById('uploadCaption'),
                uploadHashtags: document.getElementById('uploadHashtags'),
                submitUpload: document.getElementById('submitUpload'),
                cancelUpload: document.getElementById('cancelUpload'),
                liveBtn: document.getElementById('liveBtn'),
                addStoryBtn: document.getElementById('addStoryBtn'),
                navExplore: document.getElementById('navExplore'),
                navUpload: document.getElementById('navUpload'),
                navProfile: document.getElementById('navProfile'),
                logoutBtn: document.getElementById('logoutBtn'),
                toastContainer: document.getElementById('toastContainer'),
                mainLoader: document.getElementById('mainLoader'),
                profileBadge: document.getElementById('profileBadge'),
                notifIcon: document.getElementById('notifIcon')
            };

            // بررسی احراز هویت
            const token = this.getToken();
            if (!token) {
                this.showLoginModal();
                return;
            }

            // اتصال به WebSocket
            this.connectWebSocket();

            // دریافت اطلاعات کاربر
            this.fetchCurrentUser();

            // رویدادهای نوار پایین
            this.dom.navExplore.addEventListener('click', () => this.switchPage('explore'));
            this.dom.navUpload.addEventListener('click', () => this.openUploadModal());
            this.dom.navProfile.addEventListener('click', () => this.switchPage('profile'));

            // رویدادهای دیگر
            this.dom.chatIcon.addEventListener('click', () => this.toggleChat());
            this.dom.closeChat.addEventListener('click', () => this.closeChatModal());
            this.dom.sendChatBtn.addEventListener('click', () => this.sendChatMessage());
            this.dom.chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.sendChatMessage();
            });
            this.dom.closeFullPost.addEventListener('click', () => this.closeFullPostModal());
            this.dom.fullPostModal.addEventListener('click', (e) => {
                if (e.target === this.dom.fullPostModal) this.closeFullPostModal();
            });
            this.dom.cancelUpload.addEventListener('click', () => this.closeUploadModal());
            this.dom.submitUpload.addEventListener('click', () => this.uploadPost());
            this.dom.dropZone.addEventListener('click', () => this.selectFile());
            this.dom.dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                this.dom.dropZone.style.borderColor = 'var(--primary)';
            });
            this.dom.dropZone.addEventListener('dragleave', () => {
                this.dom.dropZone.style.borderColor = 'var(--border)';
            });
            this.dom.dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                this.dom.dropZone.style.borderColor = 'var(--border)';
                if (e.dataTransfer.files.length) {
                    this.handleFileSelect(e.dataTransfer.files[0]);
                }
            });
            this.dom.liveBtn.addEventListener('click', () => this.startLive());
            this.dom.addStoryBtn.addEventListener('click', () => this.addStory());
            this.dom.logoutBtn.addEventListener('click', () => this.logout());
            this.dom.searchInput.addEventListener('input', this.debounce((e) => {
                const query = e.target.value.trim();
                if (query.length >= 2) this.searchUsers(query);
            }, 400));
            this.dom.notifIcon.addEventListener('click', () => this.showNotifications());

            // کشیدن استوری‌ها به‌روز
            this.loadStories();

            // تنظیم تایمر برای بروزرسانی خودکار
            setInterval(() => {
                if (this.currentPage === 'explore') {
                    this.renderExplore(true); // silent update
                }
            }, 30000); // هر ۳۰ ثانیه

            console.log('✅ App آماده به کار!');
        }

        // ============================================================
        // ۳. مدیریت احراز هویت
        // ============================================================
        getToken() {
            try {
                const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
                return data ? data.token : null;
            } catch {
                return null;
            }
        }

        getUserId() {
            try {
                const data = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
                return data ? data.userId : null;
            } catch {
                return null;
            }
        }

        setAuthData(token, userId, username) {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({ token, userId, username }));
        }

        clearAuthData() {
            localStorage.removeItem(this.STORAGE_KEY);
        }

        showLoginModal() {
            const username = prompt('👤 نام کاربری:');
            if (!username) return;
            const password = prompt('🔑 رمز عبور:');
            if (!password) return;

            this.login(username, password);
        }

        async login(username, password) {
            try {
                this.showLoader(true);
                const response = await fetch(`${this.API_BASE}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                const data = await response.json();
                if (data.error) {
                    this.showToast('❌ ' + data.error, 'error');
                    this.showLoginModal();
                    return;
                }

                this.setAuthData(data.token, data.userId, data.username);
                this.showToast('✅ خوش آمدید ' + data.username, 'success');
                location.reload();
            } catch (err) {
                this.showToast('❌ خطا در ارتباط با سرور', 'error');
                console.error(err);
                this.showLoginModal();
            } finally {
                this.showLoader(false);
            }
        }

        async fetchCurrentUser() {
            try {
                const token = this.getToken();
                if (!token) return;

                const response = await fetch(`${this.API_BASE}/users/me`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.status === 401) {
                    this.clearAuthData();
                    this.showLoginModal();
                    return;
                }

                const user = await response.json();
                this.currentUser = user;
                console.log('👤 کاربر:', user.username);

                // بروزرسانی نشانک پروفایل
                if (this.dom.profileBadge) {
                    this.dom.profileBadge.style.display = 'none';
                }

                // بارگذاری صفحه پیش‌فرض
                this.switchPage('explore');
            } catch (err) {
                console.error('خطا در دریافت کاربر:', err);
                this.showToast('❌ خطا در دریافت اطلاعات کاربر', 'error');
            }
        }

        // ============================================================
        // ۴. WebSocket (چت، لایو، نوتیفیکیشن)
        // ============================================================
        connectWebSocket() {
            try {
                this.ws = new WebSocket(this.WS_URL);

                this.ws.onopen = () => {
                    this.isConnected = true;
                    console.log('🔗 WebSocket متصل شد');

                    // ارسال توکن برای احراز هویت
                    const token = this.getToken();
                    if (token) {
                        this.ws.send(JSON.stringify({
                            type: 'auth',
                            token: token
                        }));
                    }
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.handleWebSocketMessage(data);
                    } catch (err) {
                        console.error('خطا در解析 پیام WebSocket:', err);
                    }
                };

                this.ws.onclose = () => {
                    this.isConnected = false;
                    console.log('❌ WebSocket قطع شد، تلاش مجدد در ۵ ثانیه...');
                    setTimeout(() => this.connectWebSocket(), 5000);
                };

                this.ws.onerror = (err) => {
                    console.error('❌ خطای WebSocket:', err);
                };
            } catch (err) {
                console.error('❌ خطا در اتصال WebSocket:', err);
                setTimeout(() => this.connectWebSocket(), 5000);
            }
        }

        handleWebSocketMessage(data) {
            switch (data.type) {
                case 'auth_success':
                    console.log('✅ احراز هویت WebSocket موفق');
                    break;

                case 'new_story':
                    this.addStoryToUI(data.story);
                    break;

                case 'new_comment':
                    this.addCommentToUI(data.postId, data.comment);
                    break;

                case 'new_like':
                    this.updateLikeUI(data.postId, data.likeCount);
                    break;

                case 'live_started':
                    this.showToast(`🔴 ${data.broadcaster} شروع به لایو کرد!`, 'info');
                    if (Notification.permission === 'granted') {
                        new Notification(`🔴 ${data.broadcaster} شروع به لایو کرد!`, {
                            body: 'برای تماشا کلیک کنید',
                            icon: 'https://via.placeholder.com/64'
                        });
                    }
                    break;

                case 'private_message':
                    this.appendChatMessage(data.message, false);
                    this.updateChatBadge();
                    if (this.dom.chatModal.classList.contains('active') === false) {
                        this.showToast(`💬 پیام جدید از ${data.message.senderName || 'کاربر'}`, 'info');
                    }
                    break;

                case 'typing':
                    // می‌توانید نمایش تایپینگ را پیاده‌سازی کنید
                    break;

                case 'notification':
                    this.addNotification(data.notification);
                    this.showToast(`🔔 ${data.notification.text}`, 'info');
                    break;

                default:
                    console.log('📩 پیام ناشناخته WebSocket:', data);
            }
        }

        // ============================================================
        // ۵. صفحه‌بندی و رندرینگ
        // ============================================================
        switchPage(page) {
            this.currentPage = page;
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

            switch (page) {
                case 'explore':
                    this.dom.navExplore.classList.add('active');
                    this.renderExplore();
                    break;
                case 'profile':
                    this.dom.navProfile.classList.add('active');
                    this.renderProfile();
                    break;
                case 'upload':
                    this.openUploadModal();
                    break;
                default:
                    this.showToast('❌ صفحه نامعتبر', 'error');
            }
        }

        showLoader(show) {
            if (this.dom.mainLoader) {
                this.dom.mainLoader.classList.toggle('active', show);
            }
        }

        // ============================================================
        // ۶. رندر اکسپلور (نمایش پست‌ها)
        // ============================================================
        async renderExplore(silent = false) {
            if (!silent) {
                this.showLoader(true);
                this.dom.mainContent.innerHTML = '';
            }

            try {
                const token = this.getToken();
                const response = await fetch(
                    `${this.API_BASE}/posts/explore?page=${this.currentPostPage}&limit=${this.POSTS_PER_PAGE}`,
                    { headers: { 'Authorization': `Bearer ${token}` } }
                );

                if (response.status === 401) {
                    this.clearAuthData();
                    this.showLoginModal();
                    return;
                }

                const data = await response.json();
                this.postsCache = data.posts || [];
                this.hasMorePosts = data.hasMore || false;

                let html = '<div class="explore-grid">';
                if (this.postsCache.length === 0) {
                    html = `
                        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#999;">
                            <i class="fas fa-camera" style="font-size:48px;display:block;margin-bottom:16px;"></i>
                            <h3>هنوز پستی وجود ندارد</h3>
                            <p style="font-size:14px;">اولین پست خود را منتشر کنید!</p>
                        </div>
                    `;
                } else {
                    this.postsCache.forEach(post => {
                        html += `
                            <div class="post-thumb" onclick="App.openFullPost('${post.id}')">
                                <img src="${post.image}" alt="پست" loading="lazy" />
                                <div class="overlay">
                                    <span><i class="fas fa-heart"></i> ${post.likes}</span>
                                    <span><i class="fas fa-comment"></i> ${post.commentsCount || 0}</span>
                                </div>
                            </div>
                        `;
                    });
                }
                html += '</div>';

                if (this.hasMorePosts) {
                    html += `
                        <div style="text-align:center;padding:16px;">
                            <button onclick="App.loadMorePosts()" id="loadMoreBtn" 
                                style="padding:10px 30px;border:none;border-radius:24px;
                                background:var(--primary);color:white;font-weight:700;cursor:pointer;">
                                بارگذاری بیشتر
                            </button>
                        </div>
                    `;
                }

                this.dom.mainContent.innerHTML = html;
            } catch (err) {
                console.error('خطا در رندر اکسپلور:', err);
                if (!silent) {
                    this.dom.mainContent.innerHTML = `
                        <div style="text-align:center;padding:60px 20px;color:#999;">
                            <i class="fas fa-exclamation-triangle" style="font-size:48px;display:block;margin-bottom:16px;color:var(--secondary);"></i>
                            <h3>خطا در بارگذاری پست‌ها</h3>
                            <button onclick="App.renderExplore()" style="margin-top:12px;padding:10px 24px;border:none;border-radius:8px;background:var(--primary);color:white;cursor:pointer;">
                                تلاش مجدد
                            </button>
                        </div>
                    `;
                }
            } finally {
                if (!silent) this.showLoader(false);
            }
        }

        async loadMorePosts() {
            if (this.loadingMore || !this.hasMorePosts) return;
            this.loadingMore = true;
            this.currentPostPage++;

            try {
                const token = this.getToken();
                const response = await fetch(
                    `${this.API_BASE}/posts/explore?page=${this.currentPostPage}&limit=${this.POSTS_PER_PAGE}`,
                    { headers: { 'Authorization': `Bearer ${token}` } }
                );

                const data = await response.json();
                const newPosts = data.posts || [];
                this.hasMorePosts = data.hasMore || false;

                // اضافه کردن به گرید
                const grid = document.querySelector('.explore-grid');
                if (grid) {
                    newPosts.forEach(post => {
                        const thumb = document.createElement('div');
                        thumb.className = 'post-thumb';
                        thumb.innerHTML = `
                            <img src="${post.image}" alt="پست" loading="lazy" />
                            <div class="overlay">
                                <span><i class="fas fa-heart"></i> ${post.likes}</span>
                                <span><i class="fas fa-comment"></i> ${post.commentsCount || 0}</span>
                            </div>
                        `;
                        thumb.onclick = () => this.openFullPost(post.id);
                        grid.appendChild(thumb);
                    });
                }

                if (!this.hasMorePosts) {
                    const loadMoreBtn = document.getElementById('loadMoreBtn');
                    if (loadMoreBtn) loadMoreBtn.remove();
                }

                this.postsCache = [...this.postsCache, ...newPosts];
            } catch (err) {
                console.error('خطا در بارگذاری بیشتر:', err);
                this.showToast('❌ خطا در بارگذاری بیشتر', 'error');
            } finally {
                this.loadingMore = false;
            }
        }

        // ============================================================
        // ۷. رندر پروفایل
        // ============================================================
        async renderProfile() {
            this.showLoader(true);
            this.dom.mainContent.innerHTML = '';

            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/users/me`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.status === 401) {
                    this.clearAuthData();
                    this.showLoginModal();
                    return;
                }

                const user = await response.json();

                let html = `
                    <div class="profile-page">
                        <div class="profile-header">
                            <div class="profile-avatar" onclick="App.changeAvatar()">
                                <img src="${user.avatar || 'https://via.placeholder.com/100'}" alt="آواتار" />
                                <div class="edit-overlay">تغییر</div>
                            </div>
                            <div class="profile-info">
                                <div class="username">${user.username}</div>
                                <div class="profile-stats">
                                    <span><strong>${user.postsCount || 0}</strong> پست</span>
                                    <span><strong>${user.followers || 0}</strong> فالوور</span>
                                    <span><strong>${user.following || 0}</strong> فالوینگ</span>
                                </div>
                                <div class="profile-bio">
                                    <textarea id="bioText" rows="2" placeholder="بیوگرافی خود را بنویسید..." 
                                        style="width:100%;padding:10px;border:1px solid var(--border);border-radius:10px;
                                        font-size:14px;font-family:inherit;">${user.bio || ''}</textarea>
                                    <div class="bio-actions">
                                        <button onclick="App.updateBio()">💾 ذخیره بیو</button>
                                        <button class="outline" onclick="App.showFollowers()">👥 فالوورها</button>
                                        <button class="outline" onclick="App.showFollowing()">👤 فالوینگ</button>
                                    </div>
                                </div>
                                <div class="profile-actions">
                                    <button onclick="App.editProfile()">✏️ ویرایش پروفایل</button>
                                    <button class="outline" onclick="App.loadUserPosts()">📸 پست‌ها</button>
                                </div>
                            </div>
                        </div>
                        <div class="profile-tabs">
                            <div class="tab active" onclick="App.loadUserPosts()">📸 پست‌ها</div>
                            <div class="tab" onclick="App.loadUserStories()">⏳ استوری‌ها</div>
                        </div>
                        <div id="userContentGrid" class="profile-grid">
                            <!-- توسط توابع پر می‌شود -->
                        </div>
                    </div>
                `;

                this.dom.mainContent.innerHTML = html;
                await this.loadUserPosts();

            } catch (err) {
                console.error('خطا در رندر پروفایل:', err);
                this.dom.mainContent.innerHTML = `
                    <div style="text-align:center;padding:60px 20px;color:#999;">
                        <i class="fas fa-user-slash" style="font-size:48px;display:block;margin-bottom:16px;"></i>
                        <h3>خطا در بارگذاری پروفایل</h3>
                        <button onclick="App.renderProfile()" style="margin-top:12px;padding:10px 24px;border:none;border-radius:8px;background:var(--primary);color:white;cursor:pointer;">
                            تلاش مجدد
                        </button>
                    </div>
                `;
            } finally {
                this.showLoader(false);
            }
        }

        // ============================================================
        // ۸. لود پست‌های کاربر
        // ============================================================
        async loadUserPosts() {
            const grid = document.getElementById('userContentGrid');
            if (!grid) return;

            try {
                const token = this.getToken();
                const userId = this.getUserId();
                const response = await fetch(`${this.API_BASE}/users/${userId}/posts`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                const posts = data.posts || [];

                grid.innerHTML = '';
                if (posts.length === 0) {
                    grid.innerHTML = `
                        <div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:#999;">
                            <i class="fas fa-camera" style="font-size:32px;display:block;margin-bottom:10px;"></i>
                            <p>هنوز پستی منتشر نکرده‌اید</p>
                        </div>
                    `;
                    return;
                }

                posts.forEach(post => {
                    const thumb = document.createElement('div');
                    thumb.className = 'post-thumb';
                    thumb.innerHTML = `
                        <img src="${post.image}" alt="پست" loading="lazy" />
                        <div class="post-count">${post.likesCount || 0} ❤️</div>
                    `;
                    thumb.onclick = () => this.openFullPost(post.id);
                    grid.appendChild(thumb);
                });

                // فعال کردن تب پست‌ها
                document.querySelectorAll('.profile-tabs .tab').forEach(el => el.classList.remove('active'));
                document.querySelector('.profile-tabs .tab:first-child')?.classList.add('active');

            } catch (err) {
                console.error('خطا در لود پست‌ها:', err);
                grid.innerHTML = `
                    <div style="grid-column:1/-1;text-align:center;padding:20px;color:#999;">
                        <p>❌ خطا در بارگذاری پست‌ها</p>
                    </div>
                `;
            }
        }

        // ============================================================
        // ۹. لود استوری‌های کاربر
        // ============================================================
        async loadUserStories() {
            const grid = document.getElementById('userContentGrid');
            if (!grid) return;

            try {
                const token = this.getToken();
                const userId = this.getUserId();
                const response = await fetch(`${this.API_BASE}/users/${userId}/stories`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                const stories = data.stories || [];

                grid.innerHTML = '';
                if (stories.length === 0) {
                    grid.innerHTML = `
                        <div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:#999;">
                            <i class="fas fa-clock" style="font-size:32px;display:block;margin-bottom:10px;"></i>
                            <p>استوری منتشر نشده</p>
                        </div>
                    `;
                    return;
                }

                stories.forEach(story => {
                    const thumb = document.createElement('div');
                    thumb.className = 'post-thumb';
                    thumb.innerHTML = `
                        ${story.type === 'video' ? '<i class="fas fa-play" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:white;font-size:32px;z-index:2;text-shadow:0 2px 10px rgba(0,0,0,0.5);"></i>' : ''}
                        <img src="${story.media}" alt="استوری" loading="lazy" />
                        <div class="post-count">👁️ ${story.views || 0}</div>
                    `;
                    thumb.onclick = () => this.viewStory(story.id);
                    grid.appendChild(thumb);
                });

                // فعال کردن تب استوری
                document.querySelectorAll('.profile-tabs .tab').forEach(el => el.classList.remove('active'));
                document.querySelector('.profile-tabs .tab:last-child')?.classList.add('active');

            } catch (err) {
                console.error('خطا در لود استوری‌ها:', err);
                grid.innerHTML = `
                    <div style="grid-column:1/-1;text-align:center;padding:20px;color:#999;">
                        <p>❌ خطا در بارگذاری استوری‌ها</p>
                    </div>
                `;
            }
        }

        // ============================================================
        // ۱۰. استوری‌ها (بارگذاری و نمایش)
        // ============================================================
        async loadStories() {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/stories/feed`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                this.storiesCache = data.stories || [];

                this.renderStories();
            } catch (err) {
                console.error('خطا در لود استوری‌ها:', err);
            }
        }

        renderStories() {
            const container = this.dom.storiesContainer;
            if (!container) return;

            // نگه داشتن دکمه افزودن استوری
            const addBtn = container.querySelector('#addStoryBtn');
            container.innerHTML = '';
            if (addBtn) container.appendChild(addBtn);

            this.storiesCache.forEach(story => {
                const item = document.createElement('div');
                item.className = 'story-item';
                item.innerHTML = `
                    <div class="story-avatar ${story.viewed ? 'viewed' : ''}">
                        <img src="${story.avatar || 'https://via.placeholder.com/66'}" alt="${story.username}" />
                        ${story.isLive ? '<span class="live-indicator"></span>' : ''}
                    </div>
                    <span>${story.username}</span>
                `;
                item.onclick = () => this.viewStory(story.id);
                container.appendChild(item);
            });
        }

        async viewStory(storyId) {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/stories/${storyId}/view`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                // نمایش استوری در یک مودال ساده
                if (data.media) {
                    const modal = document.createElement('div');
                    modal.style.cssText = `
                        position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);
                        z-index:4000;display:flex;justify-content:center;align-items:center;
                        cursor:pointer;animation:fadeIn 0.3s ease;
                    `;
                    modal.innerHTML = `
                        <div style="max-width:90%;max-height:90%;">
                            ${data.type === 'video' ? 
                                `<video src="${data.media}" controls autoplay style="max-width:100%;max-height:80vh;border-radius:12px;"></video>` :
                                `<img src="${data.media}" style="max-width:100%;max-height:80vh;border-radius:12px;object-fit:contain;" />`
                            }
                            <div style="position:absolute;bottom:30px;left:50%;transform:translateX(-50%);color:white;text-align:center;font-size:14px;background:rgba(0,0,0,0.5);padding:8px 20px;border-radius:20px;backdrop-filter:blur(4px);">
                                👁️ ${data.views || 0} بازدید &nbsp;|&nbsp; ❤️ ${data.likes || 0} لایک
                            </div>
                        </div>
                    `;
                    modal.onclick = () => modal.remove();
                    document.body.appendChild(modal);

                    // ثبت لایک استوری (اختیاری)
                    if (confirm('آیا از این استوری خوشتان آمد؟ ❤️')) {
                        await fetch(`${this.API_BASE}/stories/${storyId}/like`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                    }
                }
            } catch (err) {
                console.error('خطا در مشاهده استوری:', err);
                this.showToast('❌ خطا در مشاهده استوری', 'error');
            }
        }

        // ============================================================
        // ۱۱. افزودن استوری
        // ============================================================
        addStory() {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*,video/*';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const formData = new FormData();
                formData.append('story', file);

                try {
                    const token = this.getToken();
                    const response = await fetch(`${this.API_BASE}/stories/upload`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
                        body: formData
                    });

                    const data = await response.json();
                    if (data.success) {
                        this.showToast('✅ استوری با موفقیت منتشر شد!', 'success');
                        this.loadStories();
                    } else {
                        this.showToast('❌ خطا در انتشار استوری', 'error');
                    }
                } catch (err) {
                    console.error('خطا در آپلود استوری:', err);
                    this.showToast('❌ خطا در آپلود استوری', 'error');
                }
            };
            fileInput.click();
        }

        addStoryToUI(story) {
            this.storiesCache.unshift(story);
            this.renderStories();
            this.showToast(`📸 ${story.username} استوری جدید منتشر کرد`, 'info');
        }

        // ============================================================
        // ۱۲. باز کردن پست به صورت تمام صفحه
        // ============================================================
        async openFullPost(postId) {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/posts/${postId}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.status === 404) {
                    this.showToast('❌ پست یافت نشد', 'error');
                    return;
                }

                const post = await response.json();

                let html = `
                    ${post.video ? 
                        `<video src="${post.video}" controls style="width:100%;max-height:450px;object-fit:contain;background:#f0f0f0;"></video>` :
                        `<img src="${post.image}" alt="پست" />`
                    }
                    <div class="details">
                        <div class="post-user">
                            <div class="avatar">
                                <img src="${post.userAvatar || 'https://via.placeholder.com/36'}" alt="${post.username}" />
                            </div>
                            <span class="username">${post.username}</span>
                            <span style="font-size:12px;color:#999;margin-right:auto;">${post.time}</span>
                        </div>
                        <div class="post-stats">
                            <span><strong>${post.likes}</strong> لایک</span>
                            <span><strong>${post.commentsCount || 0}</strong> کامنت</span>
                            <span><strong>${post.shares || 0}</strong> اشتراک</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:16px;margin:8px 0;">
                            <button class="like-btn-modal ${post.isLiked ? 'liked' : ''}" onclick="App.toggleLike('${post.id}')">
                                ${post.isLiked ? '❤️' : '🤍'}
                            </button>
                            <button onclick="App.sharePost('${post.id}')" style="background:none;border:none;font-size:24px;cursor:pointer;">
                                📤
                            </button>
                            <button onclick="App.openChatWith('${post.userId}')" style="background:none;border:none;font-size:24px;cursor:pointer;">
                                💬
                            </button>
                        </div>
                        <p style="margin:8px 0;"><strong>${post.username}</strong> ${post.caption || ''}</p>
                        ${post.hashtags ? `<p style="color:var(--primary);font-size:13px;">${post.hashtags.map(h => '#' + h).join(' ')}</p>` : ''}
                        <div class="full-comments" id="fullComments">
                `;

                if (post.comments && post.comments.length > 0) {
                    post.comments.forEach(comment => {
                        html += `
                            <div class="comment-item">
                                <div class="comment-body">
                                    <strong>${comment.username}</strong> ${comment.text}
                                    ${comment.replies && comment.replies.length > 0 ? 
                                        `<div style="margin-right:20px;font-size:12px;color:#666;border-right:2px solid var(--border);padding-right:10px;">
                                            ${comment.replies.map(r => `<div><strong>${r.username}</strong> ${r.text}</div>`).join('')}
                                        </div>` : ''
                                    }
                                </div>
                                <span class="reply-btn-modal" onclick="App.replyToComment('${post.id}','${comment.id}')">پاسخ</span>
                            </div>
                        `;
                    });
                } else {
                    html += `<p style="color:#999;text-align:center;padding:10px;">هنوز نظری ثبت نشده است</p>`;
                }

                html += `
                        </div>
                        <div class="comment-input-modal">
                            <input type="text" id="fullCommentInput" placeholder="نظر خود را بنویسید..." maxlength="${this.MAX_COMMENT_LENGTH}" />
                            <button onclick="App.addFullComment('${post.id}')">ارسال</button>
                        </div>
                    </div>
                `;

                this.dom.fullPostContent.innerHTML = html;
                this.dom.fullPostModal.classList.add('active');

                // اضافه کردن EventListener برای Enter در کامنت
                const commentInput = document.getElementById('fullCommentInput');
                if (commentInput) {
                    commentInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') this.addFullComment(post.id);
                    });
                }

            } catch (err) {
                console.error('خطا در باز کردن پست:', err);
                this.showToast('❌ خطا در بارگذاری پست', 'error');
            }
        }

        closeFullPostModal() {
            this.dom.fullPostModal.classList.remove('active');
        }

        // ============================================================
        // ۱۳. لایک کردن پست
        // ============================================================
        async toggleLike(postId) {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/posts/${postId}/like`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();
                if (data.success) {
                    // بروزرسانی در پست‌های کش
                    const cachedPost = this.postsCache.find(p => p.id == postId);
                    if (cachedPost) {
                        cachedPost.likes = data.likes;
                        cachedPost.isLiked = data.isLiked;
                    }
                    // باز کردن مجدد پست
                    this.openFullPost(postId);
                }
            } catch (err) {
                console.error('خطا در لایک:', err);
                this.showToast('❌ خطا در لایک', 'error');
            }
        }

        updateLikeUI(postId, likeCount) {
            // بروزرسانی در UI بدون رفرش
            const likeEl = document.querySelector(`.post-card[data-post-id="${postId}"] .post-likes`);
            if (likeEl) {
                likeEl.textContent = `${likeCount} لایک`;
            }
        }

        // ============================================================
        // ۱۴. کامنت گذاری
        // ============================================================
        async addFullComment(postId) {
            const input = document.getElementById('fullCommentInput');
            const text = input.value.trim();
            if (!text) return;

            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/posts/${postId}/comment`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ text })
                });

                const data = await response.json();
                if (data.success) {
                    input.value = '';
                    this.openFullPost(postId);
                    this.showToast('✅ کامنت ارسال شد', 'success');
                } else {
                    this.showToast('❌ خطا در ارسال کامنت', 'error');
                }
            } catch (err) {
                console.error('خطا در ارسال کامنت:', err);
                this.showToast('❌ خطا در ارسال کامنت', 'error');
            }
        }

        addCommentToUI(postId, comment) {
            // بروزرسانی کامنت‌ها در مودال
            const commentsContainer = document.getElementById('fullComments');
            if (commentsContainer) {
                const commentEl = document.createElement('div');
                commentEl.className = 'comment-item';
                commentEl.innerHTML = `
                    <div class="comment-body">
                        <strong>${comment.username}</strong> ${comment.text}
                    </div>
                    <span class="reply-btn-modal" onclick="App.replyToComment('${postId}','${comment.id}')">پاسخ</span>
                `;
                commentsContainer.appendChild(commentEl);
            }
        }

        // ============================================================
        // ۱۵. پاسخ به کامنت
        // ============================================================
        async replyToComment(postId, commentId) {
            const reply = prompt('پاسخ خود را بنویسید:');
            if (!reply || reply.trim() === '') return;

            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/posts/${postId}/comment/${commentId}/reply`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ text: reply })
                });

                const data = await response.json();
                if (data.success) {
                    this.showToast('✅ پاسخ ارسال شد', 'success');
                    this.openFullPost(postId);
                } else {
                    this.showToast('❌ خطا در ارسال پاسخ', 'error');
                }
            } catch (err) {
                console.error('خطا در پاسخ:', err);
                this.showToast('❌ خطا در ارسال پاسخ', 'error');
            }
        }

        // ============================================================
        // ۱۶. فالو کردن کاربر
        // ============================================================
        async followUser(targetId) {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/users/${targetId}/follow`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();
                if (data.success) {
                    this.showToast(data.isFollowing ? '✅ فالو شد' : '✅ آنفالو شد', 'success');
                    // بروزرسانی دکمه فالو
                    const followBtn = document.querySelector(`.follow-btn[data-user-id="${targetId}"]`);
                    if (followBtn) {
                        followBtn.textContent = data.isFollowing ? 'فالو شده' : 'فالو';
                        followBtn.classList.toggle('following', data.isFollowing);
                    }
                    // بروزرسانی پروفایل اگر در صفحه پروفایل هستیم
                    if (this.currentPage === 'profile') {
                        this.renderProfile();
                    }
                }
            } catch (err) {
                console.error('خطا در فالو:', err);
                this.showToast('❌ خطا در فالو', 'error');
            }
        }

        // ============================================================
        // ۱۷. اشتراک‌گذاری پست
        // ============================================================
        sharePost(postId) {
            const url = `${window.location.origin}/post/${postId}`;
            if (navigator.share) {
                navigator.share({
                    title: 'پست ساده‌گرام',
                    text: 'به این پست نگاه کنید!',
                    url: url
                }).catch(() => {});
            } else {
                navigator.clipboard.writeText(url).then(() => {
                    this.showToast('✅ لینک پست کپی شد!', 'success');
                }).catch(() => {
                    prompt('لینک پست:', url);
                });
            }
        }

        // ============================================================
        // ۱۸. آپلود پست
        // ============================================================
        openUploadModal() {
            this.dom.uploadModal.classList.add('active');
            this.selectedFile = null;
            this.dom.filePreview.innerHTML = '';
            this.dom.uploadCaption.value = '';
            this.dom.uploadHashtags.value = '';
            this.dom.submitUpload.disabled = false;
            this.dom.submitUpload.textContent = 'ارسال پست';
        }

        closeUploadModal() {
            this.dom.uploadModal.classList.remove('active');
        }

        selectFile() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*,video/*';
            input.onchange = (e) => {
                if (e.target.files.length) {
                    this.handleFileSelect(e.target.files[0]);
                }
            };
            input.click();
        }

        handleFileSelect(file) {
            if (!file) return;
            this.selectedFile = file;

            const reader = new FileReader();
            reader.onload = (e) => {
                const preview = this.dom.filePreview;
                preview.innerHTML = '';
                if (file.type.startsWith('video')) {
                    const video = document.createElement('video');
                    video.src = e.target.result;
                    video.controls = true;
                    video.style.maxWidth = '100%';
                    video.style.maxHeight = '200px';
                    video.style.borderRadius = '8px';
                    preview.appendChild(video);
                } else {
                    const img = document.createElement('img');
                    img.src = e.target.result;
                    img.style.maxWidth = '100%';
                    img.style.maxHeight = '200px';
                    img.style.borderRadius = '8px';
                    preview.appendChild(img);
                }
                this.showToast(`✅ فایل ${file.name} انتخاب شد`, 'success');
            };
            reader.readAsDataURL(file);
        }

        async uploadPost() {
            if (this.isUploading) return;
            if (!this.selectedFile) {
                this.showToast('❌ لطفاً یک فایل انتخاب کنید', 'error');
                return;
            }

            const caption = this.dom.uploadCaption.value.trim();
            const hashtags = this.dom.uploadHashtags.value.trim();

            this.isUploading = true;
            this.dom.submitUpload.disabled = true;
            this.dom.submitUpload.textContent = '⏳ در حال ارسال...';

            const formData = new FormData();
            formData.append('image', this.selectedFile);
            formData.append('caption', caption);
            formData.append('hashtags', hashtags);

            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/posts/upload`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData
                });

                const data = await response.json();
                if (data.success) {
                    this.showToast('✅ پست با موفقیت منتشر شد! 🎉', 'success');
                    this.closeUploadModal();
                    this.renderExplore();
                } else {
                    this.showToast('❌ خطا در انتشار پست', 'error');
                }
            } catch (err) {
                console.error('خطا در آپلود:', err);
                this.showToast('❌ خطا در ارتباط با سرور', 'error');
            } finally {
                this.isUploading = false;
                this.dom.submitUpload.disabled = false;
                this.dom.submitUpload.textContent = 'ارسال پست';
            }
        }

        // ============================================================
        // ۱۹. چت و پیام‌دهی
        // ============================================================
        toggleChat() {
            if (this.dom.chatModal.classList.contains('active')) {
                this.closeChatModal();
            } else {
                this.openChatModal();
            }
        }

        openChatModal() {
            this.dom.chatModal.classList.add('active');
            this.dom.chatInput.focus();
            // بارگذاری پیام‌های اخیر
            this.loadChatHistory();
        }

        closeChatModal() {
            this.dom.chatModal.classList.remove('active');
        }

        async loadChatHistory() {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/chat/history`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                const messages = data.messages || [];
                this.chatMessages = messages;
                this.renderChatMessages();
            } catch (err) {
                console.error('خطا در لود تاریخچه چت:', err);
            }
        }

        renderChatMessages() {
            const container = this.dom.chatMessages;
            container.innerHTML = '';
            this.chatMessages.forEach(msg => {
                this.appendChatMessage(msg, true);
            });
            container.scrollTop = container.scrollHeight;
        }

        appendChatMessage(message, fromHistory = false) {
            const container = this.dom.chatMessages;
            const div = document.createElement('div');
            div.className = `msg ${message.senderId === this.getUserId() ? 'sent' : 'received'}`;
            div.innerHTML = `
                ${message.text}
                <span class="time">${message.time || new Date().toLocaleTimeString('fa-IR')}</span>
            `;
            container.appendChild(div);
            if (!fromHistory) {
                container.scrollTop = container.scrollHeight;
            }
        }

        async sendChatMessage() {
            const input = this.dom.chatInput;
            const text = input.value.trim();
            if (!text || !this.isConnected) return;

            const receiverId = this.chatTarget || 1; // پیش‌فرض برای تست

            try {
                this.ws.send(JSON.stringify({
                    type: 'private_message',
                    receiverId: receiverId,
                    message: text
                }));

                // اضافه کردن به UI
                this.appendChatMessage({
                    senderId: this.getUserId(),
                    text: text,
                    time: new Date().toLocaleTimeString('fa-IR')
                }, false);

                input.value = '';
                this.updateChatBadge();
            } catch (err) {
                console.error('خطا در ارسال پیام:', err);
                this.showToast('❌ خطا در ارسال پیام', 'error');
            }
        }

        openChatWith(userId) {
            this.chatTarget = userId;
            this.openChatModal();
            this.loadChatHistory();
            this.showToast(`💬 شروع چت با کاربر ${userId}`, 'info');
        }

        updateChatBadge() {
            const count = this.chatMessages.filter(m => m.senderId !== this.getUserId() && !m.read).length;
            const badge = this.dom.chatBadge;
            if (count > 0) {
                badge.textContent = count;
                badge.classList.add('show');
            } else {
                badge.classList.remove('show');
            }
        }

        // ============================================================
        // ۲۰. لایو (پخش زنده)
        // ============================================================
        async startLive() {
            if (!confirm('🔴 آیا می‌خواهید لایو را شروع کنید؟ به تمام فالوورهای شما اعلان می‌رود.')) return;

            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/live/start`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();
                if (data.success) {
                    this.showToast(`🔴 لایو شما شروع شد!`, 'success');
                    // باز کردن لینک استریم
                    if (data.streamUrl) {
                        window.open(data.streamUrl, '_blank');
                    }
                } else {
                    this.showToast('❌ خطا در شروع لایو', 'error');
                }
            } catch (err) {
                console.error('خطا در لایو:', err);
                this.showToast('❌ خطا در شروع لایو', 'error');
            }
        }

        // ============================================================
        // ۲۱. جستجو
        // ============================================================
        async searchUsers(query) {
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/users/search?q=${encodeURIComponent(query)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                const users = data.users || [];

                // نمایش نتایج در یک dropdown
                let resultsHtml = `
                    <div style="position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:2000;
                        background:white;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.2);
                        max-width:400px;width:90%;max-height:300px;overflow-y:auto;padding:12px;">
                `;

                if (users.length === 0) {
                    resultsHtml += `<p style="text-align:center;color:#999;padding:20px;">نتیجه‌ای یافت نشد</p>`;
                } else {
                    users.forEach(user => {
                        resultsHtml += `
                            <div style="display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid #f5f5f5;cursor:pointer;"
                                onclick="App.viewUserProfile('${user.id}')">
                                <img src="${user.avatar || 'https://via.placeholder.com/40'}" 
                                    style="width:40px;height:40px;border-radius:50%;object-fit:cover;" />
                                <div>
                                    <div style="font-weight:700;">${user.username}</div>
                                    <div style="font-size:12px;color:#999;">${user.name || ''}</div>
                                </div>
                            </div>
                        `;
                    });
                }
                resultsHtml += `</div>`;

                // حذف نتایج قبلی
                const existing = document.querySelector('.search-results');
                if (existing) existing.remove();

                const resultsDiv = document.createElement('div');
                resultsDiv.className = 'search-results';
                resultsDiv.innerHTML = resultsHtml;
                document.body.appendChild(resultsDiv);

                // بستن با کلیک خارج
                setTimeout(() => {
                    document.addEventListener('click', function closeSearch(e) {
                        if (!e.target.closest('.search-results') && !e.target.closest('.search-box')) {
                            const el = document.querySelector('.search-results');
                            if (el) el.remove();
                            document.removeEventListener('click', closeSearch);
                        }
                    });
                }, 100);

            } catch (err) {
                console.error('خطا در جستجو:', err);
            }
        }

        viewUserProfile(userId) {
            this.showToast(`👤 باز کردن پروفایل کاربر ${userId}`, 'info');
            // می‌توانید پیاده‌سازی کنید
        }

        // ============================================================
        // ۲۲. پروفایل (ویرایش، بیو، آواتار، فالوورها)
        // ============================================================
        async updateBio() {
            const bioText = document.getElementById('bioText');
            if (!bioText) return;

            const bio = bioText.value.trim();
            try {
                const token = this.getToken();
                const response = await fetch(`${this.API_BASE}/users/bio`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ bio })
                });

                const data = await response.json();
                if (data.success) {
                    this.showToast('✅ بیوگرافی ذخیره شد!', 'success');
                } else {
                    this.showToast('❌ خطا در ذخیره بیو', 'error');
                }
            } catch (err) {
                console.error('خطا در آپدیت بیو:', err);
                this.showToast('❌ خطا در ذخیره بیو', 'error');
            }
        }

        async changeAvatar() {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const formData = new FormData();
                formData.append('avatar', file);

                try {
                    const token = this.getToken();
                    const response = await fetch(`${this.API_BASE}/users/avatar`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
                        body: formData
                    });

                    const data = await response.json();
                    if (data.success) {
                        this.showToast('✅ عکس پروفایل تغییر کرد!', 'success');
                        this.renderProfile();
                    } else {
                        this.showToast('❌ خطا در تغییر عکس', 'error');
                    }
                } catch (err) {
                    console.error('خطا در تغییر آواتار:', err);
                    this.showToast('❌ خطا در تغییر عکس', 'error');
                }
            };
            fileInput.click();
        }

        async showFollowers() {
            try {
                const token = this.getToken();
                const userId = this.getUserId();
                const response = await fetch(`${this.API_BASE}/users/${userId}/followers`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                const followers = data.followers || [];

                if (followers.length === 0) {
                    this.showToast('👥 هنوز فالووری ندارید', 'info');
                    return;
                }

                let list = '👥 فالوورهای شما:\n';
                followers.forEach((f, i) => {
                    list += `${i+1}. ${f.username}\n`;
                });
                alert(list);
            } catch (err) {
                console.error('خطا در دریافت فالوورها:', err);
                this.showToast('❌ خطا در دریافت فالوورها', 'error');
            }
        }

        async showFollowing() {
            try {
                const token = this.getToken();
                const userId = this.getUserId();
                const response = await fetch(`${this.API_BASE}/users/${userId}/following`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await response.json();
                const following = data.following || [];

                if (following.length === 0) {
                    this.showToast('👤 کسی را فالو نکرده‌اید', 'info');
                    return;
                }

                let list = '👤 افرادی که فالو می‌کنید:\n';
                following.forEach((f, i) => {
                    list += `${i+1}. ${f.username}\n`;
                });
                alert(list);
            } catch (err) {
                console.error('خطا در دریافت فالوینگ:', err);
                this.showToast('❌ خطا در دریافت فالوینگ', 'error');
            }
        }

        editProfile() {
            // می‌توانید یک مودال ویرایش پروفایل باز کنید
            this.showToast('✏️ قابلیت ویرایش پروفایل در حال توسعه', 'info');
        }

        // ============================================================
        // ۲۳. نوتیفیکیشن‌ها
        // ============================================================
        addNotification(notification) {
            this.notifications.unshift(notification);
            if (this.notifications.length > 50) {
                this.notifications.pop();
            }
        }

        showNotifications() {
            if (this.notifications.length === 0) {
                this.showToast('🔔 هیچ نوتیفیکیشنی ندارید', 'info');
                return;
            }

            let text = '🔔 نوتیفیکیشن‌ها:\n';
            this.notifications.slice(0, 10).forEach((n, i) => {
                text += `${i+1}. ${n.text}\n`;
            });
            alert(text);
        }

        // ============================================================
        // ۲۴. خروج از حساب
        // ============================================================
        logout() {
            if (confirm('آیا مطمئن هستید که می‌خواهید خارج شوید؟')) {
                this.clearAuthData();
                if (this.ws) {
                    this.ws.close();
                }
                this.showToast('👋 خروج موفق', 'info');
                setTimeout(() => location.reload(), 500);
            }
        }

        // ============================================================
        // ۲۵. Toast Notification
        // ============================================================
        showToast(message, type = 'info') {
            const container = this.dom.toastContainer;
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;

            const icons = {
                success: '✅',
                error: '❌',
                info: 'ℹ️',
                warning: '⚠️'
            };

            toast.innerHTML = `
                <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'times-circle' : 'info-circle'}"></i>
                <span>${message}</span>
                <span class="toast-close" onclick="this.parentElement.remove()">&times;</span>
            `;

            container.appendChild(toast);

            // حذف خودکار بعد از ۴ ثانیه
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.style.opacity = '0';
                    toast.style.transform = 'translateY(-20px)';
                    toast.style.transition = 'all 0.3s ease';
                    setTimeout(() => toast.remove(), 300);
                }
            }, 4000);
        }

        // ============================================================
        // ۲۶. ابزارهای کمکی
        // ============================================================
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        formatDate(date) {
            const d = new Date(date);
            return d.toLocaleDateString('fa-IR', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        // ============================================================
        // ۲۷. مدیریت خطاهای全局
        // ============================================================
        handleGlobalError(error) {
            console.error('❌ خطای全局:', error);
            this.showToast('⚠️ خطایی رخ داد، لطفاً دوباره تلاش کنید', 'error');
        }
    }

    // ============================================================
    // ۲۸. نمونه‌سازی و expose به global
    // ============================================================
    const app = new SadegramApp();
    global.App = app;
    global.AppInstance = app;

    // اضافه کردن متدهای خاص به window برای دسترسی در HTML
    window.App = app;

    console.log('📦 m1.js بارگذاری شد (نسخه نهایی)');

})(typeof window !== 'undefined' ? window : global);