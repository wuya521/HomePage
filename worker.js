export default {
  async fetch(request, env) {
    // 注入环境变量到全局，以兼容原有逻辑（或修改 handleRequest 传入 env）
    return handleRequest(request, env);
  }
};

// CORS 配置 - 允许前端跨域访问
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// 处理 CORS 预检请求
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

// 添加 CORS 头到响应
function addCorsHeaders(response) {
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

// JSON 响应辅助函数
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS
    }
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url)
  const path = url.pathname

  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  // 优先处理静态资源（如果配置了 Workers Assets）
  // 这样会自动使用项目中的 index.html, static/*.js, static/*.css 等文件
  // 解决乱码问题的核心：让 Cloudflare 托管真实的静态文件，而不是在代码里写死字符串
  if (env.ASSETS && !path.startsWith('/api/') && path !== '/manage' && path !== '/login' && path !== '/logout' && !path.startsWith('/manage/')) {
    try {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        return response;
      }
    } catch (e) {
      console.error('Assets fetch error:', e);
    }
  }
  
  // 获取KV命名空间
  const kv = env.MY_HOME_KV // 需在Workers dashboard中绑定
  if (!kv) {
    console.log('KV namespace not bound, using fallback')
    // 临时返回空数据，避免报错
    return jsonResponse({ 
      error: 'KV namespace not bound',
      message: '请在 Cloudflare Workers 控制台绑定 MY_HOME_KV 命名空间'
    }, 500);
  }
  
  // 检查登录状态（除了登录页面和API接口）
  if (path === '/manage' && !(await checkAuth(request, kv))) {
    return new Response(getLoginPage(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }
  
  // 处理登录请求
  if (path === '/login' && request.method === 'POST') {
    return await handleLogin(request, kv)
  }
  
  // 处理登出请求
  if (path === '/logout') {
    return new Response('', {
      status: 302,
      headers: {
        'Location': '/manage',
        'Set-Cookie': 'auth_token=; Path=/; Max-Age=0'
      }
    })
  }

  if (path === '/api/data' && request.method === 'GET') {
    try {
      // 从KV获取数据
      const data = await kv.get('portfolio_data', { type: 'json' })
      if (!data) {
        // 返回默认的空数据结构
        const defaultData = {
          data: {
            github: '',
            web_info: {},
            quoteData: '',
            timelineData: [],
            projectsData: [],
            sitesData: [],
            skillsData: [],
            socialData: [],
            tagsData: [],
            imagesData: [],
            profileData: {},
            locationData: {},
            portalData: [],
            noticeData: [],
            adData: [],
            ice: false,
            thema: false
          },
          last_time: null
        }
        return new Response(JSON.stringify(defaultData), {
          status: 200,
          headers: { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
  }

  if (path === '/api/data' && request.method === 'POST') {
    // 检查是否已登录
    if (!(await checkAuth(request, kv))) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
    
    try {
      const newData = await request.json()
      // 验证数据格式
      if (!newData.data || typeof newData.data !== 'object') {
        return new Response(JSON.stringify({ error: 'Invalid data format: data must be an object' }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
      // 设置默认字段
      const requiredFields = ['github', 'web_info', 'quoteData', 'timelineData', 'projectsData', 'sitesData', 'skillsData', 'socialData', 'tagsData', 'imagesData', 'profileData', 'locationData', 'portalData', 'noticeData', 'adData', 'ice', 'thema'];
      for (const field of requiredFields) {
        if (!(field in newData.data)) {
          if (field.endsWith('Data')) {
            newData.data[field] = [];
          } else if (field === 'web_info' || field === 'profileData' || field === 'locationData') {
            newData.data[field] = {};
          } else if (field === 'ice' || field === 'thema') {
            newData.data[field] = false;
          } else {
            newData.data[field] = '';
          }
        }
      }
      // 添加最后更新时间
      newData.last_time = new Date().toISOString()
      
      // 存储到KV
      await kv.put('portfolio_data', JSON.stringify(newData))
      return new Response(JSON.stringify({ 
        message: 'Data updated successfully',
        last_time: newData.last_time
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
  }

  // 密码修改API
  if (path === '/api/change-password' && request.method === 'POST') {
    // 检查是否已登录
    if (!(await checkAuth(request, kv))) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
    
    try {
      const { username, password } = await request.json()
      if (!username || !password) {
        return new Response(JSON.stringify({ error: 'Username and password required' }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
      
      // 更新管理员凭证
      const newCreds = { username, password }
      await kv.put('admin_credentials', JSON.stringify(newCreds))
      
      return new Response(JSON.stringify({ message: 'Password updated successfully' }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
  }

  // IP获取API
  if (path === '/api/visitor-ip' && request.method === 'GET') {
    try {
      // 获取访客真实IP地址
      const clientIP = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      request.headers.get('X-Real-IP') || 
                      '未知IP';

      // 获取国家信息（Cloudflare提供）
      const country = request.cf?.country || '未知';
      const city = request.cf?.city || '未知';
      const region = request.cf?.region || '未知';

      // 处理IPv6地址显示
      let displayIP = clientIP;
      if (clientIP.includes(':') && clientIP.length > 20) {
        displayIP = clientIP.substring(0, 26) + '...';
      }

      // 构建位置信息
      const locationParts = [country, region, city].filter(part => part && part !== '未知');
      const location = locationParts.length > 0 ? locationParts.join(' ') : '未知位置';

      const response = {
        ip: displayIP,
        fullIP: clientIP,
        country: country,
        region: region,
        city: city,
        location: location,
        displayText: `${displayIP}<br>(${location} 的好友)`
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Failed to get IP information',
        ip: '无法获取IP地址',
        displayText: '无法获取IP地址'
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }

  // 管理页面
  if (path === '/manage') {
    return new Response(getManagementPage(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }

  // ==================== 用户认证 API ====================
  
  // 用户注册
  if (path === '/api/auth/register' && request.method === 'POST') {
    return await handleUserRegister(request, kv);
  }
  
  // 用户登录
  if (path === '/api/auth/login' && request.method === 'POST') {
    return await handleUserLogin(request, kv);
  }
  
  // 获取当前用户信息
  if (path === '/api/auth/me' && request.method === 'GET') {
    return await handleGetCurrentUser(request, kv);
  }
  
  // 用户登出（可选：token 黑名单）
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return await handleUserLogout(request, kv);
  }
  
  // ==================== 管理员用户管理 API ====================
  
  // 获取用户列表（管理员）
  if (path === '/api/admin/users' && request.method === 'GET') {
    if (!(await checkAuth(request, kv))) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return await handleGetUsers(kv);
  }
  
  // 更新用户信息（管理员设置 verified/vip）
  if (path === '/api/admin/user/update' && request.method === 'POST') {
    if (!(await checkAuth(request, kv))) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return await handleUpdateUser(request, kv);
  }
  
  // 删除用户（管理员）
  if (path === '/api/admin/user/delete' && request.method === 'POST') {
    if (!(await checkAuth(request, kv))) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return await handleDeleteUser(request, kv);
  }

  // 处理静态资源
  if (path.startsWith('/static/')) {
    try {
      // 从 KV 获取静态文件，如果没有则返回默认内容
      const fileName = path.replace('/static/', '')
      
      if (fileName === 'style.css') {
        const css = `/* 默认样式 */
body { margin: 0; font-family: Arial, sans-serif; background: #1a1a2e; color: #fff; }
.main-container { display: flex; min-height: 100vh; }
.sidebar { width: 300px; background: rgba(255,255,255,0.05); padding: 20px; }
.content-area { flex: 1; padding: 20px; }
.profile-avatar img { width: 100px; height: 100px; border-radius: 50%; }`
        return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
      }
      
      if (fileName === 'script.js') {
        const js = `// 修复后的脚本
const API_BASE_URL = '';
let GITHUB_USERNAME = 'IonRh'; // 默认值
let FEATURE_ICE = false; // 夏日空调
let FEATURE_THEMA = false; // 背景切换

// ==================== 用户认证系统 ====================

function getAuthToken() { return localStorage.getItem('auth_token'); }
function setAuthToken(token) { localStorage.setItem('auth_token', token); }
function clearAuthToken() { localStorage.removeItem('auth_token'); }

function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
  const loginError = document.getElementById('login-error');
  const registerError = document.getElementById('register-error');
  if (loginError) loginError.textContent = '';
  if (registerError) registerError.textContent = '';
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const tabs = document.querySelectorAll('.auth-tab');
  tabs.forEach(t => t.classList.remove('active'));
  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    tabs[0].classList.add('active');
  } else {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    tabs[1].classList.add('active');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  
  if (!username || !password) {
    errorEl.textContent = '请填写用户名和密码';
    return;
  }

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    if (!response.ok) {
      errorEl.textContent = data.error || '登录失败';
      return;
    }
    setAuthToken(data.token);
    closeAuthModal();
    updateUserUI(data.user);
    window.location.reload();
  } catch (error) {
    errorEl.textContent = '网络错误';
    console.error('登录错误:', error);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const nickname = document.getElementById('register-nickname').value.trim();
  const password = document.getElementById('register-password').value;
  const confirm = document.getElementById('register-confirm').value;
  const errorEl = document.getElementById('register-error');
  
  if (!username || !password) {
    errorEl.textContent = '请填写用户名和密码';
    return;
  }
  if (password !== confirm) {
    errorEl.textContent = '两次输入的密码不一致';
    return;
  }
  if (password.length < 6) {
    errorEl.textContent = '密码长度不能少于6位';
    return;
  }
  
  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname: nickname || username })
    });
    const data = await response.json();
    if (!response.ok) {
      errorEl.textContent = data.error || '注册失败';
      return;
    }
    setAuthToken(data.token);
    closeAuthModal();
    updateUserUI(data.user);
    window.location.reload();
  } catch (error) {
    errorEl.textContent = '网络错误';
    console.error('注册错误:', error);
  }
}

async function handleLogout() {
  const token = getAuthToken();
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
    } catch (e) { console.error(e); }
  }
  clearAuthToken();
  updateUserUI(null);
  window.location.reload();
}

async function fetchCurrentUser() {
  const token = getAuthToken();
  if (!token) return null;
  try {
    const response = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!response.ok) {
      clearAuthToken();
      return null;
    }
    const data = await response.json();
    return data.user;
  } catch { return null; }
}

function updateUserUI(user) {
  const guestEl = document.getElementById('user-guest');
  const loggedEl = document.getElementById('user-logged');
  const nicknameEl = document.getElementById('user-nickname');
  const verifiedBadge = document.getElementById('badge-verified');
  const vipBadge = document.getElementById('badge-vip');
  
  if (!guestEl || !loggedEl) return;
  
  if (user) {
    guestEl.classList.add('hidden');
    loggedEl.classList.remove('hidden');
    if (nicknameEl) nicknameEl.textContent = user.nickname || user.username;
    if (verifiedBadge) user.verified ? verifiedBadge.classList.remove('hidden') : verifiedBadge.classList.add('hidden');
    if (vipBadge) user.vip ? vipBadge.classList.remove('hidden') : vipBadge.classList.add('hidden');
  } else {
    guestEl.classList.remove('hidden');
    loggedEl.classList.add('hidden');
    if (verifiedBadge) verifiedBadge.classList.add('hidden');
    if (vipBadge) vipBadge.classList.add('hidden');
  }
}

function initAuth() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (registerForm) registerForm.addEventListener('submit', handleRegister);
  
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAuthModal();
    });
  }
  
  fetchCurrentUser().then(user => updateUserUI(user));
}

// ==================== GitHub 贡献图 ====================

async function fetchGitHubContributions(username) {
  try {
    console.log('正在获取GitHub贡献数据...');
    // 尝试多个API源
    const {data, source} = await fetchGitHubContributionsFromAPI(username);
    updateContributionChart(data, source);
  } catch (error) {
    console.error('获取GitHub贡献数据失败:', error);
    const mockData = generateMockContributions();
    updateContributionChart(mockData, 'generated');
  }
}

async function fetchGitHubContributionsFromAPI(username) {
  const apiSources = [
    { 
      name: 'GitHub Contributions API', 
      url: \`https://github-contributions-api.jogruber.de/v4/\${username}\`,
      parser: (data) => {
        return (data.contributions || []).map(c => ({
          date: c.date,
          count: c.count,
          level: c.level || getContributionLevel(c.count)
        }));
      }
    },
    {
      name: 'Alternative API',
      url: \`https://github-calendar-api.vercel.app/api/\${username}\`,
      parser: (data) => {
        const contributions = [];
        if (data && data.contributions) {
           for (const [date, count] of Object.entries(data.contributions)) {
             contributions.push({ date, count, level: getContributionLevel(count) });
           }
        }
        return contributions;
      }
    }
  ];

  for (const source of apiSources) {
    try {
      const response = await fetch(source.url);
      if (response.ok) {
        const data = await response.json();
        const contributions = source.parser(data);
        if (contributions.length > 0) return { data: contributions, source: 'api' };
      }
    } catch (e) { console.warn(source.name + ' failed'); }
  }
  
  throw new Error('All APIs failed');
}

function getContributionLevel(count) {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 6) return 2;
  if (count <= 9) return 3;
  return 4;
}

function generateMockContributions() {
  const data = [];
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    data.push({
      date: d.toISOString().split('T')[0],
      count: 0,
      level: Math.random() > 0.8 ? Math.floor(Math.random() * 5) : 0
    });
  }
  return data;
}

function updateContributionChart(data, source) {
  const chart = document.getElementById('contribution-chart');
  if (!chart) return;
  
  // 简单渲染热力图网格
  chart.innerHTML = '';
  
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.alignItems = 'center';
  container.style.width = '100%';
  
  const grid = document.createElement('div');
  grid.style.display = 'flex';
  grid.style.flexWrap = 'wrap';
  grid.style.gap = '3px';
  grid.style.justifyContent = 'center';
  grid.style.maxWidth = '100%';
  
  // 排序
  data.sort((a, b) => new Date(a.date) - new Date(b.date));
  const recentData = data.slice(-365); // 最近一年
  
  recentData.forEach(day => {
    const el = document.createElement('div');
    el.style.width = '10px';
    el.style.height = '10px';
    el.style.borderRadius = '2px';
    el.style.backgroundColor = getLevelColor(day.level);
    el.title = \`\${day.date}: \${day.count} contributions\`;
    grid.appendChild(el);
  });
  
  container.appendChild(grid);
  
  // 底部说明
  const legend = document.createElement('div');
  legend.style.marginTop = '10px';
  legend.style.fontSize = '12px';
  legend.style.color = 'rgba(255,255,255,0.6)';
  legend.style.display = 'flex';
  legend.style.alignItems = 'center';
  legend.style.gap = '5px';
  
  legend.innerHTML = \`
    <span>Less</span>
    <span style="display:inline-block;width:10px;height:10px;background:#ebedf0;border-radius:2px;"></span>
    <span style="display:inline-block;width:10px;height:10px;background:#9be9a8;border-radius:2px;"></span>
    <span style="display:inline-block;width:10px;height:10px;background:#40c463;border-radius:2px;"></span>
    <span style="display:inline-block;width:10px;height:10px;background:#30a14e;border-radius:2px;"></span>
    <span style="display:inline-block;width:10px;height:10px;background:#216e39;border-radius:2px;"></span>
    <span>More</span>
    <span style="margin-left:10px;">\${source === 'api' ? '(数据来源: API)' : '(数据来源: 模拟)'}</span>
  \`;
  
  container.appendChild(legend);
  chart.appendChild(container);
}

function getLevelColor(level) {
  switch(level) {
    case 0: return 'rgba(255,255,255,0.1)'; 
    case 1: return '#0e4429';
    case 2: return '#006d32';
    case 3: return '#26a641';
    case 4: return '#39d353';
    default: return 'rgba(255,255,255,0.1)';
  }
}

// ==================== 页面渲染 ====================

function renderProfile(data) {
  const profile = data.profileData || {};
  const location = data.locationData || {};
  const images = data.imagesData || [];
  
  const avatarImg = images.find(i => i.avatar)?.avatar;
  if (avatarImg) {
      const imgEl = document.querySelector('.profile-avatar img');
      if (imgEl) imgEl.src = avatarImg;
  }
  
  const bgImg = images.find(i => i.bg_image)?.bg_image;
  if (bgImg) {
      document.body.style.backgroundImage = 'url(' + bgImg + ')';
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundAttachment = 'fixed';
  }
  
  const decos = profile.avatarDecorations || [];
  const decoContainer = document.querySelector('.avatar-decorations');
  if (decoContainer) decoContainer.innerHTML = decos.map(d => '<span>' + d + '</span>').join('');
  
  const statusEmoji = document.querySelector('.status .emoji');
  if (statusEmoji) statusEmoji.textContent = profile.statusEmoji || '';
  
  const statusTitle = document.querySelector('.status .title');
  if (statusTitle) statusTitle.textContent = profile.statusTitle || '';
  
  const quoteSpan = document.querySelector('.quote span:last-child');
  if (quoteSpan) quoteSpan.textContent = data.quoteData || '';
  
  const locSpan = document.querySelector('.location span');
  if (locSpan) locSpan.textContent = location.place || '';
  
  const workSpan = document.querySelector('.location-info .name span');
  if (workSpan) workSpan.textContent = location.workStatus || '';
}

function renderTimeline(timeline) {
  const container = document.querySelector('.timeline-section');
  if (!container || !timeline || !timeline.length) return;
  
  const html = timeline.map(item => \`
    <div style="margin-bottom: 15px; padding-left: 15px; border-left: 2px solid rgba(255,255,255,0.2);">
      <div style="font-size: 0.85em; opacity: 0.7;">\${item.date}</div>
      <div style="font-weight: 500;">\${item.title}</div>
    </div>
  \`).join('');
  
  container.innerHTML = '<h2><i class="fas fa-history"></i> 时间线</h2><div class="timeline-list">' + html + '</div>';
}

function renderProjects(projects) {
  const container = document.querySelector('.projects-grid');
  if (!container || !projects) return;
  
  container.innerHTML = projects.map(item => \`
    <a href="\${item.url}" target="_blank" class="project-card" style="display:block; background:rgba(255,255,255,0.05); padding:15px; border-radius:8px; text-decoration:none; color:inherit; margin-bottom:10px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="font-size:1.5em;">\${item.icon || '📦'}</div>
        <div>
          <h3 style="margin:0; font-size:1em;">\${item.name}</h3>
          <p style="margin:5px 0 0; font-size:0.85em; opacity:0.7;">\${item.desc}</p>
        </div>
      </div>
    </a>
  \`).join('');
}

function renderSites(sites) {
  const container = document.querySelector('.sites-grid');
  if (!container || !sites) return;
  
  container.innerHTML = sites.map(item => \`
    <a href="\${item.url}" target="_blank" class="site-card" style="display:inline-block; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; text-decoration:none; color:inherit; margin:5px; width:calc(50% - 15px);">
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="font-size:1.2em;">\${item.icon || '🌐'}</div>
        <div>
          <div style="font-weight:500;">\${item.name}</div>
        </div>
      </div>
    </a>
  \`).join('');
}

function renderSkills(skills) {
  const container = document.querySelector('.skills-icons');
  if (!container || !skills) return;
  
  container.innerHTML = skills.map(item => \`
    <div style="display:inline-flex; align-items:center; justify-content:center; width:40px; height:40px; background:rgba(255,255,255,0.1); border-radius:50%; margin:5px;" title="\${item.name}">
      \${item.icon || '🔧'}
    </div>
  \`).join('');
}

function renderSocial(social) {
  const container = document.querySelector('.social-links');
  if (!container || !social) return;
  
  container.innerHTML = social.map(item => \`
    <a href="\${item.url}" target="_blank" style="margin-right:10px; color:inherit; font-size:1.2em;">
      <i class="\${item.ico || 'fas fa-link'}"></i>
    </a>
  \`).join('');
}

function renderTags(tags) {
  const container = document.querySelector('.tags-section');
  if (!container || !tags) return;
  
  container.innerHTML = tags.map(tag => \`
    <span style="display:inline-block; background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:4px; font-size:0.85em; margin:2px;">\${tag}</span>
  \`).join('');
}

async function initPage() {
  try {
    const res = await fetch('/api/data').then(r => r.json());
    const data = res.data;
    if (data.web_info?.title) document.title = data.web_info.title;
    
    // 设置全局变量
    if (data.github) GITHUB_USERNAME = data.github;
    if (data.ice !== undefined) FEATURE_ICE = data.ice;
    if (data.thema !== undefined) FEATURE_THEMA = data.thema;
    
    renderProfile(data);
    renderTimeline(data.timelineData);
    renderProjects(data.projectsData);
    renderSites(data.sitesData);
    renderSkills(data.skillsData);
    renderSocial(data.socialData);
    renderTags(data.tagsData);
    
    // 加载GitHub贡献
    if (GITHUB_USERNAME) {
        fetchGitHubContributions(GITHUB_USERNAME);
    }
  } catch (e) {
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  initAuth();
  initPage();
  fetch('/api/visitor-ip')
    .then(res => res.json())
    .then(data => {
      const el = document.getElementById('visitor-ip');
      if (el) el.innerHTML = data.displayText || data.ip;
    });
});
`;
        return new Response(js, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } })
      }
      
      if (fileName === 'fontawesome.css') {
        return new Response('', { headers: { 'Content-Type': 'text/css' } })
      }
      
      return new Response('Static file not found', { status: 404 })
    } catch (error) {
      return new Response('Error loading static file', { status: 500 })
    }
  }

  // 根路径返回前端页面
  if (path === '/') {
    return new Response(getHomePage(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }

  return new Response('Not found', { status: 404 })
}

// ==================== 用户认证相关函数 ====================

// 生成用户 JWT Token
async function generateUserToken(username, kv) {
  let secretKey = await kv.get('jwt_secret_key');
  if (!secretKey) {
    secretKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    await kv.put('jwt_secret_key', secretKey);
  }
  
  const payload = {
    username: username,
    type: 'user',
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7天过期
    jti: crypto.randomUUID()
  };
  
  const payloadStr = JSON.stringify(payload);
  const payloadBase64 = btoa(unescape(encodeURIComponent(payloadStr)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payloadBase64)
  );
  
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${payloadBase64}.${signatureBase64}`;
}

// 验证用户 JWT Token
async function verifyUserToken(token, kv) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  
  const [payloadBase64, signatureBase64] = parts;
  const secretKey = await kv.get('jwt_secret_key');
  if (!secretKey) return null;
  
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(payloadBase64)
    );
    
    if (!isValid) return null;
    
    const payload = JSON.parse(decodeURIComponent(escape(atob(payloadBase64))));
    
    // 检查是否过期
    if (payload.exp && Date.now() > payload.exp) return null;
    
    // 检查是否在黑名单中
    const blacklisted = await kv.get(`token_blacklist:${payload.jti}`);
    if (blacklisted) return null;
    
    return payload;
  } catch {
    return null;
  }
}

// 从请求头获取 Bearer Token
function getBearerToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

// 密码哈希（使用 SHA-256 + salt）
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// 用户注册处理
async function handleUserRegister(request, kv) {
  try {
    const { username, password, nickname } = await request.json();
    
    // 验证输入
    if (!username || !password) {
      return jsonResponse({ error: '用户名和密码不能为空' }, 400);
    }
    
    if (username.length < 3 || username.length > 20) {
      return jsonResponse({ error: '用户名长度需在3-20个字符之间' }, 400);
    }
    
    if (password.length < 6) {
      return jsonResponse({ error: '密码长度不能少于6位' }, 400);
    }
    
    // 检查用户名是否已存在
    const existingUser = await kv.get(`user:${username}`, { type: 'json' });
    if (existingUser) {
      return jsonResponse({ error: '用户名已存在' }, 400);
    }
    
    // 创建用户
    const salt = crypto.randomUUID();
    const passHash = await hashPassword(password, salt);
    
    const userData = {
      username,
      nickname: nickname || username,
      passHash,
      salt,
      verified: false,      // 黄V认证
      vip: false,           // VIP状态
      vipExpireAt: null,    // VIP过期时间
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await kv.put(`user:${username}`, JSON.stringify(userData));
    
    // 添加到用户列表索引
    let userList = await kv.get('user_list', { type: 'json' }) || [];
    if (!userList.includes(username)) {
      userList.push(username);
      await kv.put('user_list', JSON.stringify(userList));
    }
    
    // 生成 token
    const token = await generateUserToken(username, kv);
    
    return jsonResponse({
      message: '注册成功',
      token,
      user: {
        username: userData.username,
        nickname: userData.nickname,
        verified: userData.verified,
        vip: userData.vip,
        vipExpireAt: userData.vipExpireAt
      }
    });
  } catch (error) {
    return jsonResponse({ error: '注册失败: ' + error.message }, 500);
  }
}

// 用户登录处理
async function handleUserLogin(request, kv) {
  try {
    const { username, password } = await request.json();
    
    if (!username || !password) {
      return jsonResponse({ error: '用户名和密码不能为空' }, 400);
    }
    
    // 获取用户数据
    const userData = await kv.get(`user:${username}`, { type: 'json' });
    if (!userData) {
      return jsonResponse({ error: '用户名或密码错误' }, 401);
    }
    
    // 验证密码
    const passHash = await hashPassword(password, userData.salt);
    if (passHash !== userData.passHash) {
      return jsonResponse({ error: '用户名或密码错误' }, 401);
    }
    
    // 检查 VIP 是否过期
    let vipActive = userData.vip;
    if (userData.vip && userData.vipExpireAt) {
      vipActive = new Date(userData.vipExpireAt) > new Date();
    }
    
    // 生成 token
    const token = await generateUserToken(username, kv);
    
    return jsonResponse({
      message: '登录成功',
      token,
      user: {
        username: userData.username,
        nickname: userData.nickname,
        verified: userData.verified,
        vip: vipActive,
        vipExpireAt: userData.vipExpireAt
      }
    });
  } catch (error) {
    return jsonResponse({ error: '登录失败: ' + error.message }, 500);
  }
}

// 获取当前用户信息
async function handleGetCurrentUser(request, kv) {
  try {
    const token = getBearerToken(request);
    if (!token) {
      return jsonResponse({ error: '未登录' }, 401);
    }
    
    const payload = await verifyUserToken(token, kv);
    if (!payload) {
      return jsonResponse({ error: 'Token 无效或已过期' }, 401);
    }
    
    const userData = await kv.get(`user:${payload.username}`, { type: 'json' });
    if (!userData) {
      return jsonResponse({ error: '用户不存在' }, 404);
    }
    
    // 检查 VIP 是否过期
    let vipActive = userData.vip;
    if (userData.vip && userData.vipExpireAt) {
      vipActive = new Date(userData.vipExpireAt) > new Date();
    }
    
    return jsonResponse({
      user: {
        username: userData.username,
        nickname: userData.nickname,
        verified: userData.verified,
        vip: vipActive,
        vipExpireAt: userData.vipExpireAt,
        createdAt: userData.createdAt
      }
    });
  } catch (error) {
    return jsonResponse({ error: '获取用户信息失败: ' + error.message }, 500);
  }
}

// 用户登出（将 token 加入黑名单）
async function handleUserLogout(request, kv) {
  try {
    const token = getBearerToken(request);
    if (!token) {
      return jsonResponse({ message: '已登出' });
    }
    
    const payload = await verifyUserToken(token, kv);
    if (payload && payload.jti) {
      // 将 token 加入黑名单，过期时间与 token 一致
      const ttl = Math.max(0, Math.floor((payload.exp - Date.now()) / 1000));
      if (ttl > 0) {
        await kv.put(`token_blacklist:${payload.jti}`, 'true', { expirationTtl: ttl });
      }
    }
    
    return jsonResponse({ message: '登出成功' });
  } catch (error) {
    return jsonResponse({ message: '已登出' });
  }
}

// ==================== 管理员用户管理函数 ====================

// 获取用户列表
async function handleGetUsers(kv) {
  try {
    const userList = await kv.get('user_list', { type: 'json' }) || [];
    const users = [];
    
    for (const username of userList) {
      const userData = await kv.get(`user:${username}`, { type: 'json' });
      if (userData) {
        // 检查 VIP 是否过期
        let vipActive = userData.vip;
        if (userData.vip && userData.vipExpireAt) {
          vipActive = new Date(userData.vipExpireAt) > new Date();
        }
        
        users.push({
          username: userData.username,
          nickname: userData.nickname,
          verified: userData.verified,
          vip: vipActive,
          vipExpireAt: userData.vipExpireAt,
          createdAt: userData.createdAt
        });
      }
    }
    
    return jsonResponse({ users });
  } catch (error) {
    return jsonResponse({ error: '获取用户列表失败: ' + error.message }, 500);
  }
}

// 更新用户信息（管理员设置 verified/vip）
async function handleUpdateUser(request, kv) {
  try {
    const { username, verified, vip, vipExpireAt, nickname } = await request.json();
    
    if (!username) {
      return jsonResponse({ error: '用户名不能为空' }, 400);
    }
    
    const userData = await kv.get(`user:${username}`, { type: 'json' });
    if (!userData) {
      return jsonResponse({ error: '用户不存在' }, 404);
    }
    
    // 更新字段
    if (typeof verified === 'boolean') userData.verified = verified;
    if (typeof vip === 'boolean') userData.vip = vip;
    if (vipExpireAt !== undefined) userData.vipExpireAt = vipExpireAt;
    if (nickname) userData.nickname = nickname;
    userData.updatedAt = new Date().toISOString();
    
    await kv.put(`user:${username}`, JSON.stringify(userData));
    
    return jsonResponse({
      message: '用户信息更新成功',
      user: {
        username: userData.username,
        nickname: userData.nickname,
        verified: userData.verified,
        vip: userData.vip,
        vipExpireAt: userData.vipExpireAt
      }
    });
  } catch (error) {
    return jsonResponse({ error: '更新用户失败: ' + error.message }, 500);
  }
}

// 删除用户
async function handleDeleteUser(request, kv) {
  try {
    const { username } = await request.json();
    
    if (!username) {
      return jsonResponse({ error: '用户名不能为空' }, 400);
    }
    
    // 删除用户数据
    await kv.delete(`user:${username}`);
    
    // 从用户列表中移除
    let userList = await kv.get('user_list', { type: 'json' }) || [];
    userList = userList.filter(u => u !== username);
    await kv.put('user_list', JSON.stringify(userList));
    
    return jsonResponse({ message: '用户删除成功' });
  } catch (error) {
    return jsonResponse({ error: '删除用户失败: ' + error.message }, 500);
  }
}

// 检查认证状态
async function checkAuth(request, kv) {
  const cookieHeader = request.headers.get('Cookie')
  if (!cookieHeader) return false
  
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(cookie => {
      const trimmed = cookie.trim()
      const index = trimmed.indexOf('=')
      if(index > 0){
        return [trimmed.substring(0, index), trimmed.substring(index + 1)]
      }
      return ['', ''] 
    })
  )
  
  const authToken = cookies.auth_token
  if (!authToken) return false
  
  try {
    return await verifyToken(authToken, kv)
  } catch {
    return false
  }
}

// 生成带签名的token
async function generateToken(username, kv) {
  let secretKey = await kv.get('secret_key')
  if (!secretKey) {
    secretKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    await kv.put('secret_key', secretKey)
  }
  
  const payload = {
    username: username,
    timestamp: Date.now(),
    salt: Math.random().toString(36).substring(2)
  }
  
  const payloadStr = JSON.stringify(payload)
  const payloadBase64 = btoa(payloadStr)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payloadBase64)
  )
  
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
  
  return `${payloadBase64}.${signatureBase64}`
}

async function verifyToken(token, kv) {
  const parts = token.split('.')
  if (parts.length !== 2) return false
  
  const [payloadBase64, signatureBase64] = parts
  
  const secretKey = await kv.get('secret_key')
  if (!secretKey) return false
  
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    
    const signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0))
    
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(payloadBase64)
    )
    
    if (!isValid) return false
    const payload = JSON.parse(atob(payloadBase64))
    const now = Date.now()
    return (now - payload.timestamp) < 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

// 处理登录
async function handleLogin(request, kv) {
  try {
    const formData = await request.formData()
    const username = formData.get('username')
    const password = formData.get('password')

    let adminCreds = await kv.get('admin_credentials', { type: 'json' })
    if (!adminCreds) {
      adminCreds = {
        username: 'admin',
        password: 'admin123'
      }
      await kv.put('admin_credentials', JSON.stringify(adminCreds))
    }
    
    if (username === adminCreds.username && password === adminCreds.password) {
      const token = await generateToken(username, kv)
      
      return new Response('', {
        status: 302,
        headers: {
          'Location': '/manage',
          'Set-Cookie': `auth_token=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`
        }
      })
    } else {
      return new Response(getLoginPage('用户名或密码错误'), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
  } catch (error) {
    return new Response(getLoginPage('登录失败，请重试'), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }
}

// 登录页面
function getLoginPage(errorMessage = '') {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - Home管理</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link rel="shortcut icon" href="https://blog.loadke.tech/assets/img/favico1n.png">
    <style>
      .form-input {
        border: 1px solid #d1d5db;
        transition: border-color 0.2s ease;
      }
      .form-input:focus {
        outline: none;
        border-color: #6b7280;
        box-shadow: 0 0 0 1px #6b7280;
      }
      .btn {
        transition: all 0.2s ease;
      }
      .btn:hover {
        transform: translateY(-1px);
      }
      .notification {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 1000;
        max-width: 350px;
        padding: 12px 16px;
        border-radius: 6px;
        color: white;
        font-size: 14px;
        transform: translateX(100%);
        transition: transform 0.3s ease;
      }
      .notification.show {
        transform: translateX(0);
      }
      .notification.error {
        background-color: #dc2626;
      }
    </style>
  </head>
  <body class="bg-gray-50 min-h-screen flex items-center justify-center">
    <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
      <h2 class="text-2xl font-medium text-gray-900 mb-4">登录</h2>
      ${errorMessage ? `<p class="text-red-600 text-sm mb-4">${errorMessage}</p>` : ''}
      <form action="/login" method="POST">
        <div class="mb-4">
          <label class="block text-sm text-gray-600 mb-1">用户名</label>
          <input type="text" name="username" class="form-input w-full px-3 py-2 rounded" required>
        </div>
        <div class="mb-4">
          <label class="block text-sm text-gray-600 mb-1">密码</label>
          <input type="password" name="password" class="form-input w-full px-3 py-2 rounded" required>
        </div>
        <button type="submit" class="btn w-full px-4 py-2 bg-gray-800 hover:bg-gray-900 text-white rounded">
          <i class="fas fa-sign-in-alt mr-1"></i>登录
        </button>
      </form>
    </div>
  </body>
  </html>
  `;
}

// 前端页面
function getHomePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title></title>
    <link rel="stylesheet" href="./static/style.css">
    <link rel="shortcut icon" href="./static/f2.png">
    <link rel="stylesheet" href="./static/fontawesome.css">
    <style>
        /* 用户栏样式 */
        .user-bar {
            position: fixed;
            top: 15px;
            right: 15px;
            z-index: 1000;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .user-login-btn {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: #fff;
            padding: 8px 16px;
            border-radius: 20px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s ease;
        }
        .user-login-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: translateY(-2px);
        }
        .user-logged {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 6px 12px;
            border-radius: 20px;
        }
        .user-info {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .user-nickname {
            color: #fff;
            font-size: 14px;
            font-weight: 500;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 10px;
            font-weight: bold;
        }
        .badge-verified {
            background: linear-gradient(135deg, #f5af19, #f12711);
            color: #fff;
        }
        .badge-verified i {
            font-size: 10px;
        }
        .badge-vip {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: #fff;
        }
        .user-logout-btn {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.7);
            cursor: pointer;
            padding: 4px 8px;
            font-size: 14px;
            transition: color 0.3s;
        }
        .user-logout-btn:hover {
            color: #ff6b6b;
        }
        
        /* 模态框样式 */
        .auth-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(5px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2000;
        }
        .auth-modal.hidden {
            display: none;
        }
        .auth-modal-content {
            background: linear-gradient(135deg, rgba(30, 60, 114, 0.95), rgba(42, 82, 152, 0.95));
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 16px;
            padding: 30px;
            width: 90%;
            max-width: 380px;
            position: relative;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        }
        .auth-close-btn {
            position: absolute;
            top: 15px;
            right: 15px;
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.7);
            font-size: 24px;
            cursor: pointer;
            transition: color 0.3s;
        }
        .auth-close-btn:hover {
            color: #fff;
        }
        .auth-tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 25px;
        }
        .auth-tab {
            flex: 1;
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: rgba(255, 255, 255, 0.7);
            padding: 10px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s;
        }
        .auth-tab.active {
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
        }
        .auth-form {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .auth-form.hidden {
            display: none;
        }
        .auth-form .form-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .auth-form .form-group label {
            color: rgba(255, 255, 255, 0.8);
            font-size: 13px;
        }
        .auth-form .form-group input {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            padding: 10px 12px;
            color: #fff;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        .auth-form .form-group input:focus {
            outline: none;
            border-color: rgba(255, 255, 255, 0.5);
        }
        .auth-form .form-group input::placeholder {
            color: rgba(255, 255, 255, 0.4);
        }
        .auth-submit-btn {
            background: linear-gradient(135deg, #667eea, #764ba2);
            border: none;
            color: #fff;
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            cursor: pointer;
            transition: transform 0.3s, box-shadow 0.3s;
            margin-top: 10px;
        }
        .auth-submit-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
        }
        .auth-error {
            color: #ff6b6b;
            font-size: 13px;
            text-align: center;
            margin-top: 5px;
            min-height: 20px;
        }
        .hidden {
            display: none !important;
        }
    </style>
</head>
<body>
    <!-- 用户登录/注册模态框 -->
    <div id="auth-modal" class="auth-modal hidden">
        <div class="auth-modal-content">
            <button class="auth-close-btn" onclick="closeAuthModal()">&times;</button>
            <div id="auth-tabs" class="auth-tabs">
                <button class="auth-tab active" onclick="switchAuthTab('login')">登录</button>
                <button class="auth-tab" onclick="switchAuthTab('register')">注册</button>
            </div>
            <!-- 登录表单 -->
            <form id="login-form" class="auth-form">
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" id="login-username" required placeholder="请输入用户名">
                </div>
                <div class="form-group">
                    <label>密码</label>
                    <input type="password" id="login-password" required placeholder="请输入密码">
                </div>
                <button type="submit" class="auth-submit-btn">登录</button>
                <p id="login-error" class="auth-error"></p>
            </form>
            <!-- 注册表单 -->
            <form id="register-form" class="auth-form hidden">
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" id="register-username" required placeholder="3-20个字符">
                </div>
                <div class="form-group">
                    <label>昵称</label>
                    <input type="text" id="register-nickname" placeholder="可选，默认为用户名">
                </div>
                <div class="form-group">
                    <label>密码</label>
                    <input type="password" id="register-password" required placeholder="至少6位">
                </div>
                <div class="form-group">
                    <label>确认密码</label>
                    <input type="password" id="register-confirm" required placeholder="再次输入密码">
                </div>
                <button type="submit" class="auth-submit-btn">注册</button>
                <p id="register-error" class="auth-error"></p>
            </form>
        </div>
    </div>

    <!-- 右上角用户信息栏 -->
    <div id="user-bar" class="user-bar">
        <!-- 未登录状态 -->
        <div id="user-guest" class="user-guest">
            <button class="user-login-btn" onclick="openAuthModal()">
                <i class="fas fa-user"></i> 登录 / 注册
            </button>
        </div>
        <!-- 已登录状态 -->
        <div id="user-logged" class="user-logged hidden">
            <div class="user-info">
                <span id="user-nickname" class="user-nickname"></span>
                <span id="badge-verified" class="badge badge-verified hidden" title="官方认证">
                    <i class="fas fa-check"></i>
                </span>
                <span id="badge-vip" class="badge badge-vip hidden" title="VIP会员">
                    VIP
                </span>
            </div>
            <button class="user-logout-btn" onclick="handleLogout()" title="退出登录">
                <i class="fas fa-sign-out-alt"></i>
            </button>
        </div>
    </div>

    <div class="main-container">
        <!-- 左侧个人信息 -->
        <aside class="sidebar">
            <section class="profile-section">
                <div class="profile-avatar">
                    <img src="" alt="头像">
                    <div class="avatar-decorations">
                    </div>
                </div>
                
                <div class="profile-info">
                    <div class="status">
                        <span class="emoji"></span>
                        <span class="title"></span>
                    </div>
                    <div class="quote">
                        <span class="emoji">📝</span>
                        <span></span>
                    </div>
                    
                    <div class="social-links">
                        <a href="" target="_blank"><i class="fas fa-github"></i></a>
                        <a href="" target="_blank"><i class="fas fa-envelope"></i></a>
                        <a href="" target="_blank"><i class="fas fa-paper-plane"></i></a>
                        <a href="#" onclick="showIframe()" title="夏日空调"><i class="fas fa-circle"></i></a>
                    </div>
                    
                    <div class="location-info">
                        <div class="location">
                            <i class="fa fa-map-marker"></i>
                            <span></span>
                        </div>
                        <div class="name">
                            <i class="fas fa-briefcase"></i>
                            <span></span>
                        </div>
                    </div>
                </div>
            </section>
            
            <!-- 个人标签 -->
            <section class="tags-section">
            </section>
                        
            <!-- 技能展示 -->
            <section class="skills-section">
                <h2><i class="fas fa-heart"></i> 欢迎您</h2>
                <div class="stat-item">
                    <span class="stat-label">访客IP: </span>
                    <span class="stat-number blur-effect" id="visitor-ip">获取中...</span>
                </div>
            </section>
            <br>
            <!-- 时间线 -->
            <section class="timeline-section">
            </section>
        </aside>
        
        <!-- 右侧内容区域 -->
        <main class="content-area">

            <!-- GitHub 贡献图 -->
            <section class="contribution-section">
                <h2>
                    <span id="contribution-title" class="contribution-title"><i class="fab fa-github"></i> GitHub 贡献图</span>
                    <div id="contribution-header-placeholder" class="contribution-header-placeholder"></div>
                </h2>
                <div id="contribution-chart" class="contribution-chart">
                    <div class="loading-placeholder">
                        <div class="loading-spinner"></div>
                        <span>加载贡献数据中...</span>
                    </div>
                </div>
            </section>
            
            <!-- 站点展示 -->
            <section class="sites-section">
                <h2><i class="fas fa-globe"></i> WebSite</h2>
                <div class="sites-grid">
                </div>
            </section>
            
            <!-- 项目展示 -->
            <section class="projects-section">
                <h2><i class="fas fa-cube"></i> 项目集</h2>
                <div class="projects-grid">
                </div>
            </section>
            
            <!-- 技能展示 -->
            <section class="skills-section">
                <h2><i class="fas fa-wrench"></i> 技能栈</h2>
                <div class="skills-icons">
            </section>
        </main>
    </div>
    <!-- 背景切换开关 -->
    <div id="background-toggle" class="background-toggle" title="切换背景">
        <i class="fas fa-moon"></i>
    </div>

    <footer>
            <p>© 2025 WebSite by <a id="footer-link" href="#" target="_blank">阿布白(IonRh)</a></p>
    </footer>
</body>
<script src="./static/script.js"></script>
</html>`;
}

// 管理页面
function getManagementPage() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Home管理</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link rel="shortcut icon" href="https://blog.loadke.tech/assets/img/favico1n.png">
    <style>
      .tab-content { 
        display: none; 
      }
      .tab-content.active { 
        display: block; 
      }
      .tab-button.active { 
        background-color: #374151;
        color: white;
        border-color: #374151;
      }
      .tab-button {
        transition: all 0.2s ease;
      }
      .tab-button:hover {
        background-color: #f3f4f6;
        border-color: #d1d5db;
      }
      .tab-button.active:hover {
        background-color: #4b5563;
      }
      .form-input {
        border: 1px solid #d1d5db;
        transition: border-color 0.2s ease;
      }
      .form-input:focus {
        outline: none;
        border-color: #6b7280;
        box-shadow: 0 0 0 1px #6b7280;
      }
      .btn {
        transition: all 0.2s ease;
      }
      .btn:hover {
        transform: translateY(-1px);
      }
      .notification {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 1000;
        max-width: 350px;
        padding: 12px 16px;
        border-radius: 6px;
        color: white;
        font-size: 14px;
        transform: translateX(100%);
        transition: transform 0.3s ease;
      }
      .notification.show {
        transform: translateX(0);
      }
      .notification.success { background-color: #059669; }
      .notification.error { background-color: #dc2626; }
      .notification.warning { background-color: #d97706; }
      .notification.info { background-color: #0891b2; }
    </style>
  </head>
  <body class="bg-gray-50 min-h-screen">
    <!-- 顶部导航 -->
    <nav class="bg-white shadow-sm border-b border-gray-200">
      <div class="max-w-6xl mx-auto px-4 py-3">
        <div class="flex justify-between items-center">
          <div class="flex items-center">
            <i class="fas fa-database text-gray-600 mr-2"></i>
            <h1 class="text-lg font-medium text-gray-900">Home管理</h1>
            <div class="ml-3 w-2 h-2 bg-green-500 rounded-full"></div>
          </div>
          <div class="flex items-center space-x-2">
            <a href="/logout" class="btn px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 rounded text-sm">
              <i class="fas fa-sign-out-alt mr-1"></i>登出
            </a>
          </div>
        </div>
      </div>
    </nav>
  
    <div class="max-w-6xl mx-auto p-4">
      <!-- 状态面板 -->
      <div class="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <span class="text-gray-500">状态:</span>
            <span id="dataStatus" class="ml-2 font-medium">等待加载</span>
          </div>
          <div>
            <span class="text-gray-500">最后更新:</span>
            <span id="lastUpdate" class="ml-2">--</span>
          </div>
          <div class="text-right">
            <button onclick="showPasswordModal()" class="btn px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded text-sm">
              <i class="fas fa-key mr-1"></i>修改密码
            </button>
          </div>
        </div>
      </div>
      
      <!-- 标签页 -->
      <div class="bg-white rounded-lg border border-gray-200 mb-4">
        <div class="border-b border-gray-200 p-4">
          <div class="flex flex-wrap gap-2">
            <button onclick="showTab('basic')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">基本信息</button>
            <button onclick="showTab('timeline')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">时间线</button>
            <button onclick="showTab('projects')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">项目</button>
            <button onclick="showTab('sites')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">站点</button>
            <button onclick="showTab('skills')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">技能</button>
            <button onclick="showTab('social')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">社交</button>
            <button onclick="showTab('tags')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">标签</button>
            <button onclick="showTab('images')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">图片</button>
            <button onclick="showTab('json')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm">JSON</button>
            <button onclick="showTab('users')" class="tab-button px-3 py-1.5 border border-gray-300 rounded text-sm bg-purple-50 text-purple-700 border-purple-200">用户管理</button>
            <div class="ml-auto flex items-center gap-2">
              <label class="inline-flex items-center text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded cursor-pointer">
                <input type="checkbox" id="iceToggle" class="mr-2">
                开启夏日空调（ice）
              </label>
              <label class="inline-flex items-center text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded cursor-pointer">
                <input type="checkbox" id="themaToggle" class="mr-2">
                开启背景切换（thema）
              </label>
            </div>
          </div>

        </div>
  
        <!-- 基本信息 -->
        <div id="basic" class="tab-content p-4">
          <h3 class="font-medium text-gray-900 mb-4">基本信息</h3>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm text-gray-600 mb-1">GitHub用户名</label>
              <input type="text" id="github" class="form-input w-full px-3 py-2 rounded">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">网站标题</label>
              <input type="text" id="webTitle" class="form-input w-full px-3 py-2 rounded">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">网站图标URL</label>
              <input type="text" id="webIcon" class="form-input w-full px-3 py-2 rounded">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">状态标题</label>
              <input type="text" id="statusTitle" class="form-input w-full px-3 py-2 rounded" placeholder="Full Stack Developer">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">状态表情</label>
              <input type="text" id="statusEmoji" class="form-input w-full px-3 py-2 rounded" placeholder="😊">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">位置</label>
              <input type="text" id="locationPlace" class="form-input w-full px-3 py-2 rounded" placeholder="China-AnyWhere">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">工作状态</label>
              <input type="text" id="workStatus" class="form-input w-full px-3 py-2 rounded" placeholder="流浪">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">头像装饰表情（用逗号分隔）</label>
              <input type="text" id="avatarDecorations" class="form-input w-full px-3 py-2 rounded" placeholder="🦄,😊,🎯">
            </div>
            <div class="lg:col-span-2">
              <label class="block text-sm text-gray-600 mb-1">个人引言</label>
              <textarea id="quote" class="form-input w-full px-3 py-2 rounded h-20 resize-none"></textarea>
            </div>
          </div>
        </div>


        <!-- 时间线 -->
        <div id="timeline" class="tab-content p-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-900">时间线管理</h3>
            <button onclick="addTimelineItem()" class="btn px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm">
              <i class="fas fa-plus mr-1"></i>添加
            </button>
          </div>
          <div id="timelineList" class="space-y-3"></div>
        </div>
  
        <!-- 项目 -->
        <div id="projects" class="tab-content p-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-900">项目管理</h3>
            <button onclick="addProject()" class="btn px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm">
              <i class="fas fa-plus mr-1"></i>添加
            </button>
          </div>
          <div id="projectsList" class="space-y-3"></div>
        </div>
  
        <!-- 站点 -->
        <div id="sites" class="tab-content p-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-900">站点管理</h3>
            <button onclick="addSite()" class="btn px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm">
              <i class="fas fa-plus mr-1"></i>添加
            </button>
          </div>
          <div id="sitesList" class="space-y-3"></div>
        </div>
  
        <!-- 技能 -->
        <div id="skills" class="tab-content p-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-900">技能管理</h3>
            <button onclick="addSkill()" class="btn px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm">
              <i class="fas fa-plus mr-1"></i>添加
            </button>
          </div>
          <div id="skillsList" class="space-y-3"></div>
        </div>
  
        <!-- 社交 -->
        <div id="social" class="tab-content p-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-900">社交链接</h3>
            <button onclick="addSocial()" class="btn px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm">
              <i class="fas fa-plus mr-1"></i>添加
            </button>
          </div>
          <div id="socialList" class="space-y-3"></div>
        </div>
  
        <!-- 标签 -->
        <div id="tags" class="tab-content p-4">
          <h3 class="font-medium text-gray-900 mb-4">标签管理</h3>
          <div class="flex gap-2 mb-4">
            <input type="text" id="newTag" placeholder="输入标签名称" class="form-input flex-1 px-3 py-2 rounded">
            <button onclick="addTag()" class="btn px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm">添加</button>
          </div>
          <div id="tagsList" class="flex flex-wrap gap-2"></div>
        </div>
  
        <!-- 图片 -->
        <div id="images" class="tab-content p-4">
          <h3 class="font-medium text-gray-900 mb-4">图片设置</h3>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm text-gray-600 mb-1">头像URL</label>
              <input type="text" id="avatar" class="form-input w-full px-3 py-2 rounded">
            </div>
            <div>
              <label class="block text-sm text-gray-600 mb-1">背景图片URL</label>
              <input type="text" id="bgImage" class="form-input w-full px-3 py-2 rounded">
            </div>
          </div>
        </div>
  
        <!-- JSON编辑 -->
        <div id="json" class="tab-content p-4">
          <h3 class="font-medium text-gray-900 mb-4">JSON编辑器</h3>
          <div class="mb-4">
            <textarea id="dataInput" class="form-input w-full h-80 px-3 py-2 rounded font-mono text-sm resize-none" placeholder="JSON数据将显示在这里..."></textarea>
          </div>
          <div class="flex flex-wrap gap-2">
            <button onclick="loadJsonData()" class="btn px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded text-sm">
              <i class="fas fa-download mr-1"></i>加载数据
            </button>
            <button onclick="saveJsonData()" class="btn px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm">
              <i class="fas fa-save mr-1"></i>保存数据
            </button>
            <button onclick="exportToJson()" class="btn px-3 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded text-sm">
              <i class="fas fa-export mr-1"></i>导出表单
            </button>
          </div>
        </div>

        <!-- 用户管理 -->
        <div id="users" class="tab-content p-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-900">用户管理</h3>
            <button onclick="loadUsers()" class="btn px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm">
              <i class="fas fa-sync mr-1"></i>刷新列表
            </button>
          </div>
          <div class="mb-4 p-3 bg-purple-50 border border-purple-200 rounded text-sm text-purple-800">
            <i class="fas fa-info-circle mr-1"></i>
            在此管理注册用户，可设置黄V认证和VIP状态。黄V表示官方认证用户，VIP表示会员用户。
          </div>
          <div id="usersList" class="space-y-3">
            <p class="text-gray-500 text-sm">点击"刷新列表"加载用户数据...</p>
          </div>
        </div>
      </div>
  
      <!-- 操作按钮 -->
      <div class="bg-white rounded-lg border border-gray-200 p-4 text-center">
        <div class="flex flex-col sm:flex-row gap-2 justify-center">
          <button onclick="loadAllData()" class="btn px-6 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded">
            <i class="fas fa-sync mr-1"></i>重新加载
          </button>
          <button onclick="saveAllData()" class="btn px-6 py-2 bg-gray-800 hover:bg-gray-900 text-white rounded">
            <i class="fas fa-save mr-1"></i>保存所有更改
          </button>
        </div>
      </div>
    </div>
  
    <!-- 密码修改模态框 -->
    <div id="passwordModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-lg w-full max-w-md">
        <div class="p-4 border-b border-gray-200">
          <h3 class="font-medium text-gray-900">修改登录信息</h3>
        </div>
        <div class="p-4 space-y-3">
          <div>
            <label class="block text-sm text-gray-600 mb-1">新用户名</label>
            <input type="text" id="newUsername" class="form-input w-full px-3 py-2 rounded">
          </div>
          <div>
            <label class="block text-sm text-gray-600 mb-1">新密码</label>
            <input type="password" id="newPassword" class="form-input w-full px-3 py-2 rounded">
          </div>
          <div>
            <label class="block text-sm text-gray-600 mb-1">确认密码</label>
            <input type="password" id="confirmPassword" class="form-input w-full px-3 py-2 rounded">
          </div>
          <div class="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-800">
            注意：修改后需要重新登录，密码长度不少于6位
          </div>
        </div>
        <div class="p-4 border-t border-gray-200 flex gap-2">
          <button onclick="hidePasswordModal()" class="flex-1 btn px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded">取消</button>
          <button onclick="changePassword()" class="flex-1 btn px-4 py-2 bg-gray-800 hover:bg-gray-900 text-white rounded">确认</button>
        </div>
      </div>
    </div>
  
  <script>
    let currentData = { data: {} };
  
    // 标签页切换
    function showTab(tabName, evt = null) {
      document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
      });
      document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
      });
      
      document.getElementById(tabName).classList.add('active');
      if (evt) {
        evt.target.classList.add('active');
      } else {
        const button = document.querySelector(\`.tab-button[onclick="showTab('\${tabName}')"]\`);
        if (button) button.classList.add('active');
      }
    }
  
    // 加载数据
    async function loadAllData() {
      const statusEl = document.getElementById('dataStatus');
      const lastUpdateEl = document.getElementById('lastUpdate');
      
      statusEl.textContent = '加载中...';
      statusEl.className = 'ml-2 font-medium text-orange-600';
      
      try {
        const response = await fetch('/api/data');
        const data = await response.json();
        currentData = data;
        populateFields(data.data);
        
        statusEl.textContent = '数据已加载';
        statusEl.className = 'ml-2 font-medium text-green-600';
        
        // 显示从KV获取的最后更新时间
        if (data.last_time) {
          const lastTime = new Date(data.last_time);
          lastUpdateEl.textContent = lastTime.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
        } else {
          lastUpdateEl.textContent = '从未更新';
        }
        
        showTab('basic');
        showNotification('数据加载成功', 'success');
      } catch (error) {
        statusEl.textContent = '加载失败';
        statusEl.className = 'ml-2 font-medium text-red-600';
        showNotification('加载失败: ' + error.message, 'error');
      }
    }
  
        // 填充表单
    function populateFields(data) {
      document.getElementById('github').value = data.github || '';
      document.getElementById('webTitle').value = data.web_info?.title || '';
            document.getElementById('webIcon').value = data.web_info?.icon || '';
      document.getElementById('quote').value = data.quoteData || '';

      // 布尔开关
      document.getElementById('iceToggle').checked = !!data.ice;
      document.getElementById('themaToggle').checked = !!data.thema;
      
      // 填充个人信息
      document.getElementById('statusTitle').value = data.profileData?.statusTitle || '';
      document.getElementById('statusEmoji').value = data.profileData?.statusEmoji || '';
      document.getElementById('locationPlace').value = data.locationData?.place || '';
      document.getElementById('workStatus').value = data.locationData?.workStatus || '';
      
      // 填充头像装饰
      if (data.profileData?.avatarDecorations && Array.isArray(data.profileData.avatarDecorations)) {
        document.getElementById('avatarDecorations').value = data.profileData.avatarDecorations.join(',');
      }

      const avatar = data.imagesData?.find(img => img.avatar);
      const bgImage = data.imagesData?.find(img => img.bg_image);
      document.getElementById('avatar').value = avatar?.avatar || '';
      document.getElementById('bgImage').value = bgImage?.bg_image || '';

      renderTimeline(data.timelineData || []);
      renderProjects(data.projectsData || []);
      renderSites(data.sitesData || []);
      renderSkills(data.skillsData || []);
      renderSocial(data.socialData || []);
      renderTags(data.tagsData || []);
    }
  
    // 渲染时间线
    function renderTimeline(timeline) {
      const container = document.getElementById('timelineList');
      container.innerHTML = '';
      timeline.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'bg-gray-50 border border-gray-200 rounded p-3';
                 div.innerHTML = \`
           <div class="flex flex-wrap gap-2">
             <input type="text" value="\${item.title}" onchange="updateTimelineTitle(\${index}, this.value)" 
                    placeholder="事件标题" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <input type="date" value="\${item.date}" onchange="updateTimelineDate(\${index}, this.value)" 
                    class="form-input w-auto px-2 py-1 rounded text-sm">
             <button onclick="removeTimelineItem(\${index})" 
                     class="btn px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs whitespace-nowrap">
               <i class="fas fa-trash mr-1"></i>删除
             </button>
           </div>
         \`;
        container.appendChild(div);
      });
    }
  
    // 渲染项目
    function renderProjects(projects) {
      const container = document.getElementById('projectsList');
      container.innerHTML = '';
      projects.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'bg-gray-50 border border-gray-200 rounded p-3';
                 div.innerHTML = \`
           <div class="flex flex-wrap gap-2 mb-2">
             <input type="text" value="\${item.name}" onchange="updateProjectName(\${index}, this.value)" 
                    placeholder="项目名称" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <input type="text" value="\${item.url}" onchange="updateProjectUrl(\${index}, this.value)" 
                    placeholder="项目链接" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <input type="text" value="\${item.icon}" onchange="updateProjectIcon(\${index}, this.value)" 
                    placeholder="图标" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <button onclick="removeProject(\${index})" 
                     class="btn px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs whitespace-nowrap">
               <i class="fas fa-trash mr-1"></i>删除
             </button>
           </div>
           <textarea onchange="updateProjectDesc(\${index}, this.value)" 
                     placeholder="项目描述" class="form-input w-full px-2 py-1 rounded text-sm h-16 resize-none">\${item.desc}</textarea>
         \`;
        container.appendChild(div);
      });
    }
  
    // 渲染站点
    function renderSites(sites) {
      const container = document.getElementById('sitesList');
      container.innerHTML = '';
      sites.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'bg-gray-50 border border-gray-200 rounded p-3';
                 div.innerHTML = \`
           <div class="flex flex-wrap gap-2 mb-2">
             <input type="text" value="\${item.name}" onchange="updateSiteName(\${index}, this.value)" 
                    placeholder="站点名称" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <input type="text" value="\${item.url}" onchange="updateSiteUrl(\${index}, this.value)" 
                    placeholder="站点链接" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <input type="text" value="\${item.icon}" onchange="updateSiteIcon(\${index}, this.value)" 
                    placeholder="图标" class="form-input flex-1 min-w-0 px-2 py-1 rounded text-sm">
             <button onclick="removeSite(\${index})" 
                     class="btn px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs whitespace-nowrap">
               <i class="fas fa-trash mr-1"></i>删除
             </button>
           </div>
           <textarea onchange="updateSiteDesc(\${index}, this.value)" 
                     placeholder="站点描述" class="form-input w-full px-2 py-1 rounded text-sm h-16 resize-none">\${item.desc}</textarea>
         \`;
        container.appendChild(div);
      });
    }
  
    // 渲染技能
    function renderSkills(skills) {
      const container = document.getElementById('skillsList');
      container.innerHTML = '';
      skills.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'bg-gray-50 border border-gray-200 rounded p-3';
        div.innerHTML = \`
          <div class="flex gap-3">
            <input type="text" value="\${item.name}" onchange="updateSkillName(\${index}, this.value)" 
                   placeholder="技能名称" class="form-input flex-1 px-2 py-1 rounded text-sm">
            <input type="text" value="\${item.icon}" onchange="updateSkillIcon(\${index}, this.value)" 
                   placeholder="图标" class="form-input flex-1 px-2 py-1 rounded text-sm">
            <button onclick="removeSkill(\${index})" 
                    class="btn px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        \`;
        container.appendChild(div);
      });
    }
  
    // 渲染社交
    function renderSocial(social) {
      const container = document.getElementById('socialList');
      container.innerHTML = '';
      social.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'bg-gray-50 border border-gray-200 rounded p-3';
        div.innerHTML = \`
          <div class="flex gap-3">
            <input type="text" value="\${item.url}" onchange="updateSocialUrl(\${index}, this.value)" 
                   placeholder="链接地址" class="form-input flex-1 px-2 py-1 rounded text-sm">
            <input type="text" value="\${item.ico}" onchange="updateSocialIcon(\${index}, this.value)" 
                   placeholder="图标类名" class="form-input flex-1 px-2 py-1 rounded text-sm">
            <button onclick="removeSocial(\${index})" 
                    class="btn px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        \`;
        container.appendChild(div);
      });
    }
  
    // 渲染标签
    function renderTags(tags) {
      const container = document.getElementById('tagsList');
      container.innerHTML = '';
      if (tags.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">暂无标签</p>';
        return;
      }
      tags.forEach((tag, index) => {
        const span = document.createElement('span');
        span.className = 'inline-flex items-center bg-gray-100 text-gray-800 px-2 py-1 rounded text-sm';
        span.innerHTML = \`
          \${tag}
          <button onclick="removeTag(\${index})" class="ml-1 text-red-500 hover:text-red-700">
            <i class="fas fa-times text-xs"></i>
          </button>
        \`;
        container.appendChild(span);
      });
    }
  
    // 添加函数
    function addTimelineItem() {
      if (!currentData.data.timelineData) currentData.data.timelineData = [];
      currentData.data.timelineData.push({ title: '新时间线', date: new Date().toISOString().split('T')[0] });
      renderTimeline(currentData.data.timelineData);
    }
  
    function addProject() {
      if (!currentData.data.projectsData) currentData.data.projectsData = [];
      currentData.data.projectsData.push({ name: '新项目', url: '', desc: '', icon: '' });
      renderProjects(currentData.data.projectsData);
    }
  
    function addSite() {
      if (!currentData.data.sitesData) currentData.data.sitesData = [];
      currentData.data.sitesData.push({ name: '新站点', url: '', desc: '', icon: '' });
      renderSites(currentData.data.sitesData);
    }
  
    function addSkill() {
      if (!currentData.data.skillsData) currentData.data.skillsData = [];
      currentData.data.skillsData.push({ name: '新技能', icon: '' });
      renderSkills(currentData.data.skillsData);
    }
  
    function addSocial() {
      if (!currentData.data.socialData) currentData.data.socialData = [];
      currentData.data.socialData.push({ url: '', ico: '' });
      renderSocial(currentData.data.socialData);
    }
  
    function addTag() {
      const input = document.getElementById('newTag');
      const tag = input.value.trim();
      if (tag) {
        if (!currentData.data.tagsData) currentData.data.tagsData = [];
        currentData.data.tagsData.push(tag);
        input.value = '';
        renderTags(currentData.data.tagsData);
      }
    }
  
    // 更新函数
    function updateTimelineTitle(index, value) {
      currentData.data.timelineData[index].title = value;
    }
    function updateTimelineDate(index, value) {
      currentData.data.timelineData[index].date = value;
    }
    function updateProjectName(index, value) {
      currentData.data.projectsData[index].name = value;
    }
    function updateProjectUrl(index, value) {
      currentData.data.projectsData[index].url = value;
    }
    function updateProjectIcon(index, value) {
      currentData.data.projectsData[index].icon = value;
    }
    function updateProjectDesc(index, value) {
      currentData.data.projectsData[index].desc = value;
    }
    function updateSiteName(index, value) {
      currentData.data.sitesData[index].name = value;
    }
    function updateSiteUrl(index, value) {
      currentData.data.sitesData[index].url = value;
    }
    function updateSiteIcon(index, value) {
      currentData.data.sitesData[index].icon = value;
    }
    function updateSiteDesc(index, value) {
      currentData.data.sitesData[index].desc = value;
    }
    function updateSkillName(index, value) {
      currentData.data.skillsData[index].name = value;
    }
    function updateSkillIcon(index, value) {
      currentData.data.skillsData[index].icon = value;
    }
    function updateSocialUrl(index, value) {
      currentData.data.socialData[index].url = value;
    }
    function updateSocialIcon(index, value) {
      currentData.data.socialData[index].ico = value;
    }
  
    // 删除函数
    function removeTimelineItem(index) {
      currentData.data.timelineData.splice(index, 1);
      renderTimeline(currentData.data.timelineData);
    }
    function removeProject(index) {
      currentData.data.projectsData.splice(index, 1);
      renderProjects(currentData.data.projectsData);
    }
    function removeSite(index) {
      currentData.data.sitesData.splice(index, 1);
      renderSites(currentData.data.sitesData);
    }
    function removeSkill(index) {
      currentData.data.skillsData.splice(index, 1);
      renderSkills(currentData.data.skillsData);
    }
    function removeSocial(index) {
      currentData.data.socialData.splice(index, 1);
      renderSocial(currentData.data.socialData);
    }
    function removeTag(index) {
      currentData.data.tagsData.splice(index, 1);
      renderTags(currentData.data.tagsData);
    }
  
        // 收集表单数据
    function collectFormData() {
      currentData.data.github = document.getElementById('github').value;
      currentData.data.web_info = {
        title: document.getElementById('webTitle').value,
        icon: document.getElementById('webIcon').value
      };
      currentData.data.quoteData = document.getElementById('quote').value;

      // 收集开关
      currentData.data.ice = !!document.getElementById('iceToggle').checked;
      currentData.data.thema = !!document.getElementById('themaToggle').checked;

      // 收集个人信息数据
      currentData.data.profileData = {
        statusTitle: document.getElementById('statusTitle').value,
        statusEmoji: document.getElementById('statusEmoji').value,
        avatarDecorations: document.getElementById('avatarDecorations').value.split(',').map(s => s.trim()).filter(s => s)
      };

      // 收集位置信息数据
      currentData.data.locationData = {
        place: document.getElementById('locationPlace').value,
        workStatus: document.getElementById('workStatus').value
      };

      const avatar = document.getElementById('avatar').value;
      const bgImage = document.getElementById('bgImage').value;
      currentData.data.imagesData = [];
      if (avatar) currentData.data.imagesData.push({ avatar });
      if (bgImage) currentData.data.imagesData.push({ bg_image: bgImage });
    }
  
    // 保存数据
    async function saveAllData() {
      const statusEl = document.getElementById('dataStatus');
      const lastUpdateEl = document.getElementById('lastUpdate');
      
      statusEl.textContent = '保存中...';
      statusEl.className = 'ml-2 font-medium text-orange-600';
      
      try {
        collectFormData();
        const response = await fetch('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentData)
        });
        const result = await response.json();
        
        statusEl.textContent = '保存成功';
        statusEl.className = 'ml-2 font-medium text-green-600';
        
        // 使用服务器返回的更新时间
        if (result.last_time) {
          const lastTime = new Date(result.last_time);
          lastUpdateEl.textContent = lastTime.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
          // 更新本地数据的时间戳
          currentData.last_time = result.last_time;
        } else {
          lastUpdateEl.textContent = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
        }
        
        showNotification('保存成功', 'success');
      } catch (error) {
        statusEl.textContent = '保存失败';
        statusEl.className = 'ml-2 font-medium text-red-600';
        showNotification('保存失败: ' + error.message, 'error');
      }
    }
  
    // JSON 编辑功能
    async function loadJsonData() {
      try {
        const response = await fetch('/api/data');
        const data = await response.json();
        document.getElementById('dataInput').value = JSON.stringify(data, null, 2);
        showNotification('JSON数据加载成功', 'success');
      } catch (error) {
        showNotification('加载JSON失败: ' + error.message, 'error');
      }
    }
    
    async function saveJsonData() {
      try {
        const jsonText = document.getElementById('dataInput').value;
        if (!jsonText.trim()) {
          showNotification('请输入JSON数据', 'warning');
          return;
        }
        
        const data = JSON.parse(jsonText);
        const response = await fetch('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await response.json();
        
        showNotification('JSON保存成功', 'success');
        currentData = data;
        populateFields(data.data);
        
        const statusEl = document.getElementById('dataStatus');
        const lastUpdateEl = document.getElementById('lastUpdate');
        statusEl.textContent = '数据已更新';
        statusEl.className = 'ml-2 font-medium text-green-600';
        
        // 使用服务器返回的更新时间
        if (result.last_time) {
          const lastTime = new Date(result.last_time);
          lastUpdateEl.textContent = lastTime.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
          // 更新本地数据的时间戳
          currentData.last_time = result.last_time;
        } else {
          lastUpdateEl.textContent = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
        }
        
      } catch (error) {
        if (error instanceof SyntaxError) {
          showNotification('JSON格式错误', 'error');
        } else {
          showNotification('保存失败: ' + error.message, 'error');
        }
      }
    }
  
    function exportToJson() {
      collectFormData();
      document.getElementById('dataInput').value = JSON.stringify(currentData, null, 2);
      showNotification('已导出到JSON编辑器', 'success');
    }
    
    // 密码修改
    function showPasswordModal() {
      document.getElementById('passwordModal').style.display = 'flex';
    }
    
    function hidePasswordModal() {
      document.getElementById('passwordModal').style.display = 'none';
      document.getElementById('newUsername').value = '';
      document.getElementById('newPassword').value = '';
      document.getElementById('confirmPassword').value = '';
    }
    
    async function changePassword() {
      const newUsername = document.getElementById('newUsername').value.trim();
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      
      if (!newUsername || !newPassword) {
        showNotification('用户名和密码不能为空', 'warning');
        return;
      }
      
      if (newPassword !== confirmPassword) {
        showNotification('两次输入的密码不一致', 'warning');
        return;
      }
      
      if (newPassword.length < 6) {
        showNotification('密码长度不能少于6位', 'warning');
        return;
      }
      
      try {
        const response = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: newUsername,
            password: newPassword
          })
        });
        
        const result = await response.json();
        if (response.ok) {
          showNotification('密码修改成功，3秒后跳转到登录页面', 'success');
          setTimeout(() => {
            window.location.href = '/logout';
          }, 3000);
        } else {
          showNotification(result.error || '修改失败', 'error');
        }
      } catch (error) {
        showNotification('修改失败: ' + error.message, 'error');
      }
    }
  
    // 通知系统
    function showNotification(message, type = 'info') {
      const notification = document.createElement('div');
      notification.className = \`notification \${type}\`;
      notification.innerHTML = \`
        <div class="flex items-center justify-between">
          <span>\${message}</span>
          <button onclick="this.parentElement.parentElement.remove()" class="ml-3 hover:opacity-75">
            <i class="fas fa-times"></i>
          </button>
        </div>
      \`;
      
      document.body.appendChild(notification);
      
      setTimeout(() => {
        notification.classList.add('show');
      }, 100);
      
      setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
          if (notification.parentNode) {
            notification.remove();
          }
        }, 300);
      }, 3000);
    }
    
    // 键盘快捷键
    document.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveAllData();
      }
      if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        loadAllData();
      }
    });

    // ==================== 用户管理功能 ====================
    
    // 加载用户列表
    async function loadUsers() {
      const container = document.getElementById('usersList');
      container.innerHTML = '<p class="text-gray-500 text-sm">加载中...</p>';
      
      try {
        const response = await fetch('/api/admin/users');
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.error || '加载失败');
        }
        
        renderUsers(data.users || []);
        showNotification('用户列表加载成功', 'success');
      } catch (error) {
        container.innerHTML = '<p class="text-red-500 text-sm">加载失败: ' + error.message + '</p>';
        showNotification('加载用户列表失败: ' + error.message, 'error');
      }
    }
    
    // 渲染用户列表
    function renderUsers(users) {
      const container = document.getElementById('usersList');
      
      if (users.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">暂无注册用户</p>';
        return;
      }
      
      container.innerHTML = '';
      
      users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'bg-gray-50 border border-gray-200 rounded p-4';
        div.innerHTML = \`
          <div class="flex flex-wrap items-center gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="font-medium text-gray-900">\${user.nickname || user.username}</span>
                <span class="text-gray-500 text-sm">@\${user.username}</span>
                \${user.verified ? '<span class="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full">黄V</span>' : ''}
                \${user.vip ? '<span class="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full">VIP</span>' : ''}
              </div>
              <div class="text-xs text-gray-500">
                注册时间: \${user.createdAt ? new Date(user.createdAt).toLocaleString('zh-CN') : '未知'}
                \${user.vipExpireAt ? ' | VIP到期: ' + new Date(user.vipExpireAt).toLocaleString('zh-CN') : ''}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <label class="inline-flex items-center text-sm cursor-pointer">
                <input type="checkbox" \${user.verified ? 'checked' : ''} 
                       onchange="updateUserVerified('\${user.username}', this.checked)"
                       class="mr-1">
                黄V
              </label>
              <label class="inline-flex items-center text-sm cursor-pointer">
                <input type="checkbox" \${user.vip ? 'checked' : ''} 
                       onchange="updateUserVip('\${user.username}', this.checked)"
                       class="mr-1">
                VIP
              </label>
              <button onclick="showVipExpireModal('\${user.username}', '\${user.vipExpireAt || ''}')" 
                      class="btn px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs">
                <i class="fas fa-calendar mr-1"></i>VIP时间
              </button>
              <button onclick="confirmDeleteUser('\${user.username}')" 
                      class="btn px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        \`;
        container.appendChild(div);
      });
    }
    
    // 更新用户黄V状态
    async function updateUserVerified(username, verified) {
      try {
        const response = await fetch('/api/admin/user/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, verified })
        });
        
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || '更新失败');
        }
        
        showNotification(\`已\${verified ? '开启' : '关闭'}\${username}的黄V认证\`, 'success');
      } catch (error) {
        showNotification('更新失败: ' + error.message, 'error');
        loadUsers(); // 刷新列表恢复状态
      }
    }
    
    // 更新用户VIP状态
    async function updateUserVip(username, vip) {
      try {
        const response = await fetch('/api/admin/user/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, vip })
        });
        
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || '更新失败');
        }
        
        showNotification(\`已\${vip ? '开启' : '关闭'}\${username}的VIP状态\`, 'success');
      } catch (error) {
        showNotification('更新失败: ' + error.message, 'error');
        loadUsers();
      }
    }
    
    // 显示VIP过期时间设置模态框
    function showVipExpireModal(username, currentExpire) {
      const expireDate = currentExpire ? new Date(currentExpire).toISOString().slice(0, 16) : '';
      const modal = document.createElement('div');
      modal.id = 'vipExpireModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4';
      modal.innerHTML = \`
        <div class="bg-white rounded-lg shadow-lg w-full max-w-md">
          <div class="p-4 border-b border-gray-200">
            <h3 class="font-medium text-gray-900">设置VIP过期时间 - \${username}</h3>
          </div>
          <div class="p-4 space-y-3">
            <div>
              <label class="block text-sm text-gray-600 mb-1">过期时间</label>
              <input type="datetime-local" id="vipExpireInput" value="\${expireDate}" 
                     class="form-input w-full px-3 py-2 rounded">
            </div>
            <div class="text-sm text-gray-500">
              留空表示永久VIP，设置时间后VIP将在该时间自动失效。
            </div>
          </div>
          <div class="p-4 border-t border-gray-200 flex gap-2">
            <button onclick="closeVipExpireModal()" class="flex-1 btn px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded">取消</button>
            <button onclick="saveVipExpire('\${username}')" class="flex-1 btn px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded">保存</button>
          </div>
        </div>
      \`;
      document.body.appendChild(modal);
    }
    
    // 关闭VIP过期时间模态框
    function closeVipExpireModal() {
      const modal = document.getElementById('vipExpireModal');
      if (modal) modal.remove();
    }
    
    // 保存VIP过期时间
    async function saveVipExpire(username) {
      const input = document.getElementById('vipExpireInput');
      const vipExpireAt = input.value ? new Date(input.value).toISOString() : null;
      
      try {
        const response = await fetch('/api/admin/user/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, vipExpireAt, vip: true })
        });
        
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || '更新失败');
        }
        
        closeVipExpireModal();
        loadUsers();
        showNotification('VIP过期时间已更新', 'success');
      } catch (error) {
        showNotification('更新失败: ' + error.message, 'error');
      }
    }
    
    // 确认删除用户
    function confirmDeleteUser(username) {
      if (confirm(\`确定要删除用户 "\${username}" 吗？此操作不可恢复！\`)) {
        deleteUser(username);
      }
    }
    
    // 删除用户
    async function deleteUser(username) {
      try {
        const response = await fetch('/api/admin/user/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || '删除失败');
        }
        
        loadUsers();
        showNotification(\`用户 \${username} 已删除\`, 'success');
      } catch (error) {
        showNotification('删除失败: ' + error.message, 'error');
      }
    }
  
    // 初始化
    document.addEventListener('DOMContentLoaded', function() {
      loadAllData();
    });
  </script>
  </body>
  </html>
  `;
}
