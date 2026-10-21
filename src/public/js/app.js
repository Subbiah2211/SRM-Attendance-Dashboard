/* Progressive enhancement: every page also works as a plain page load without this file.
   With it, pages are swapped in place (so full screen survives moving between pages),
   sign-in takes the browser into full screen, and charts, live refresh and the sidebar work. */
(function () {
  'use strict';
  var root = document.documentElement;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  var css = function (name) { return getComputedStyle(root).getPropertyValue(name).trim(); };
  var charts = [];
  var liveTimer = null;

  // ---------------------------------------------------------------- charts
  // <canvas data-chart='{"type":"line|bar|doughnut","labels":[...],"datasets":[{"label":"","data":[...]}],"tones":["present",...]}'>
  function drawCharts(scope) {
    if (!window.Chart) return;
    var ink = css('--ink'), muted = css('--muted'), line = css('--line'), brand = css('--brand'), surface = css('--surface');
    window.Chart.defaults.font.family = css('--font') || 'sans-serif';
    window.Chart.defaults.color = muted;
    scope.querySelectorAll('canvas[data-chart]').forEach(function (el) {
      var spec;
      try { spec = JSON.parse(el.getAttribute('data-chart')); } catch (e) { return; }
      if (el._chart) el._chart.destroy();
      var type = spec.type || 'line';
      var tones = (spec.tones || []).map(function (t) { return css('--' + t) || brand; });
      var options = {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: ink, titleColor: surface, bodyColor: surface, padding: 10, cornerRadius: 8, displayColors: type === 'doughnut' } }
      };
      var datasets = spec.datasets.map(function (d) { return Object.assign({}, d); });
      if (type === 'doughnut') {
        datasets.forEach(function (d) { d.backgroundColor = tones; d.borderColor = surface; d.borderWidth = 3; d.hoverOffset = 4; });
        options.cutout = '70%';
      } else if (type === 'bar') {
        datasets.forEach(function (d) { d.backgroundColor = brand; d.borderRadius = 6; d.maxBarThickness = 38; });
        options.scales = { y: { beginAtZero: true, max: 100, grid: { color: line }, border: { display: false }, ticks: { callback: function (v) { return v + '%'; } } }, x: { grid: { display: false }, border: { color: line } } };
      } else {
        datasets.forEach(function (d) {
          d.borderColor = brand; d.borderWidth = 2.5; d.tension = 0.35; d.fill = true; d.pointRadius = 0; d.pointHoverRadius = 5; d.pointBackgroundColor = brand; d.spanGaps = true;
          d.backgroundColor = function (ctx) {
            var area = ctx.chart.chartArea;
            if (!area) return 'transparent';
            var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, brand + '55'); g.addColorStop(1, brand + '00');
            return g;
          };
        });
        options.interaction = { mode: 'index', intersect: false };
        options.scales = { y: { suggestedMin: 60, max: 100, grid: { color: line }, border: { display: false }, ticks: { callback: function (v) { return v + '%'; } } }, x: { grid: { display: false }, border: { color: line }, ticks: { maxTicksLimit: 10 } } };
      }
      el._chart = new window.Chart(el, { type: type, data: { labels: spec.labels, datasets: datasets }, options: options });
      charts.push(el._chart);
    });
  }

  // ---------------------------------------------------------------- live camera video
  function startVideo(scope) {
    scope.querySelectorAll('video[data-hls]').forEach(function (v) {
      var url = v.getAttribute('data-hls');
      if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; return; }
      var attach = function () { if (window.Hls && window.Hls.isSupported()) { var h = new window.Hls(); h.loadSource(url); h.attachMedia(v); } };
      if (window.Hls) { attach(); return; }
      var s = document.createElement('script');
      s.src = '/vendor/hls.js'; s.onload = attach;
      document.head.appendChild(s);
    });
  }

  // Today's figures refresh every 30 seconds: re-fetch the page and swap the live region.
  function liveRefresh() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (!document.querySelector('[data-live]')) return;
    liveTimer = setInterval(function () {
      var live = document.querySelector('[data-live]');
      if (!live || document.hidden || document.querySelector('form:focus-within')) return;
      var at = window.location.href;
      fetch(at, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
        .then(function (r) { return r.ok && !r.redirected ? r.text() : null; })
        .then(function (html) {
          if (!html || window.location.href !== at) return;
          var next = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-live]');
          var now = document.querySelector('[data-live]');
          // Leave a playing video alone; refresh everything else.
          if (next && now && !now.querySelector('video, iframe, img.cam-stage')) { now.innerHTML = next.innerHTML; drawCharts(now); }
          else if (next && now) {
            ['.kpis', 'table.data'].forEach(function (sel) {
              var a = now.querySelectorAll(sel), b = next.querySelectorAll(sel);
              a.forEach(function (el, i) { if (b[i]) el.innerHTML = b[i].innerHTML; });
            });
          }
        })
        .catch(function () {});
    }, 30000);
  }

  // ---------------------------------------------------------------- face enrolment photos
  // Whatever the phone or laptop gives (PNG, HEIC, a huge JPEG) is turned into a JPEG of sensible
  // size in the browser, shown as a preview, and put back into the file box so the form sends it.
  function toJpeg(blob, name) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (out) { resolve(out ? new File([out], name, { type: 'image/jpeg' }) : null); }, 'image/jpeg', 0.92);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); }; // not a picture the browser can read
      img.src = url;
    });
  }
  function setShot(shot, file) {
    var input = shot.querySelector('input[type=file]');
    var img = shot.querySelector('.shot-frame img');
    var empty = shot.querySelector('.shot-empty');
    try { var dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; } catch (e) { /* older browsers keep the original file */ }
    if (img) { img.src = URL.createObjectURL(file); img.hidden = false; }
    if (empty) empty.hidden = true;
    shot.classList.add('has-photo');
  }
  var camStream = null, camShot = null;
  function closeCamera() {
    if (camStream) camStream.getTracks().forEach(function (t) { t.stop(); });
    camStream = null; camShot = null;
    var modal = document.querySelector('[data-cam-modal]');
    if (modal) modal.hidden = true;
  }
  function openCamera(shot) {
    var modal = document.querySelector('[data-cam-modal]');
    if (!modal) return;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then(function (stream) { camStream = stream; camShot = shot; modal.querySelector('video').srcObject = stream; modal.hidden = false; })
      .catch(function () { window.alert('The camera could not be opened. Allow camera access, or choose a photo file instead.'); });
  }
  function takePhoto() {
    var modal = document.querySelector('[data-cam-modal]');
    var video = modal && modal.querySelector('video');
    if (!video || !camShot || !video.videoWidth) return;
    var c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    var shot = camShot;
    c.toBlob(function (blob) { if (blob) setShot(shot, new File([blob], 'camera.jpg', { type: 'image/jpeg' })); closeCamera(); }, 'image/jpeg', 0.92);
  }
  function initEnrol() {
    closeCamera();
    // Taking a photo from the page needs a camera and a secure address (https or localhost).
    var can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
    document.querySelectorAll('[data-enroll] [data-cam]').forEach(function (b) { b.hidden = !can; });
  }

  // ---------------------------------------------------------------- full screen
  var fsElement = function () { return document.fullscreenElement || document.webkitFullscreenElement || null; };
  function enterFullscreen() {
    var fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!fn || fsElement()) return;
    try { var p = fn.call(root); if (p && p.catch) p.catch(function () {}); } catch (e) { /* not allowed here */ }
  }
  function leaveFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn && fsElement()) { try { var p = fn.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } }
  }
  function syncFullscreen() { root.classList.toggle('is-fs', !!fsElement()); }
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) root.classList.add('fs-supported');
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);

  // ---------------------------------------------------------------- moving between pages without a reload
  // A real page load would drop full screen, so links and forms fetch the next page and swap it in.
  var DOWNLOAD = /\/export(\?|$)|\/imports\/templates\/|\/imports\/\d+\/errors/;

  function initPage() {
    syncFullscreen();
    // Submenus: the group holding the current page is open; the others remember what the user chose.
    document.querySelectorAll('.nav-group').forEach(function (g) {
      var key = 'att.group.' + g.getAttribute('data-group');
      if (!g.hasAttribute('data-active') && store.get(key) === 'open') g.open = true;
      g.addEventListener('toggle', function () { store.set(key, g.open ? 'open' : 'closed'); });
    });
    var current = document.querySelector('.nav [aria-current="page"]');
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
    drawCharts(document);
    startVideo(document);
    initEnrol();
    liveRefresh();
    if (document.body.classList.contains('public')) leaveFullscreen();
  }

  function swap(html, url, push) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.body || !doc.body.children.length) { window.location.href = url; return; }
    var nav = document.querySelector('.nav');
    var navScroll = nav ? nav.scrollTop : 0;
    charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* already gone */ } });
    charts = [];
    document.title = doc.title;
    document.body.className = doc.body.className;
    document.body.innerHTML = doc.body.innerHTML; // script tags inside are inert; this file stays loaded
    root.classList.remove('nav-open');
    if (push && url !== window.location.href) history.pushState({}, '', url);
    nav = document.querySelector('.nav');
    if (nav) nav.scrollTop = navScroll;
    window.scrollTo(0, 0);
    initPage();
    var main = document.getElementById('main');
    if (main) main.focus({ preventScroll: true });
  }

  var navSeq = 0;
  function go(url, opts) {
    opts = opts || {};
    var mine = ++navSeq; // a slower, earlier request must not overwrite the page the user moved on to
    root.classList.add('loading');
    return fetch(url, { method: opts.method || 'GET', body: opts.body, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (type.indexOf('text/html') === -1) { if (mine === navSeq) window.location.href = url; return null; } // a file to download
        return r.text().then(function (html) { if (mine === navSeq) swap(html, r.url, opts.push !== false); });
      })
      .catch(function () { if (mine === navSeq) window.location.href = url; })
      .then(function () { if (mine === navSeq) root.classList.remove('loading'); });
  }

  var small = window.matchMedia('(max-width: 1000px)');
  function toggleNav() {
    if (small.matches) { root.classList.toggle('nav-open'); return; }
    var collapsed = root.classList.toggle('nav-collapsed');
    store.set('att.nav', collapsed ? 'collapsed' : 'open');
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 240); // charts re-measure
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-nav-toggle]')) { toggleNav(); return; }
    if (e.target.closest('[data-nav-close]')) { root.classList.remove('nav-open'); return; }
    if (e.target.closest('[data-fs-toggle]')) { if (fsElement()) leaveFullscreen(); else enterFullscreen(); return; }
    var camBtn = e.target.closest('[data-cam]');
    if (camBtn) { openCamera(camBtn.closest('[data-shot]')); return; }
    if (e.target.closest('[data-cam-take]')) { takePhoto(); return; }
    if (e.target.closest('[data-cam-cancel]')) { closeCamera(); return; }
    if (e.target.closest('[data-theme-toggle]')) {
      var dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
      store.set('att.theme', dark ? 'light' : 'dark');
      drawCharts(document);
      return;
    }
    // Close the account menu when clicking elsewhere.
    document.querySelectorAll('details.menu[open]').forEach(function (m) { if (!m.contains(e.target)) m.open = false; });

    var all = e.target.closest('[data-mark-all]');
    if (all) {
      var value = all.getAttribute('data-mark-all');
      document.querySelectorAll('select[data-mark]').forEach(function (s) { if (!s.value) s.value = value; });
      return;
    }

    // Links inside the application.
    var a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.origin !== window.location.origin) return;
    if (a.getAttribute('href').charAt(0) === '#' || DOWNLOAD.test(a.pathname + a.search)) return;
    e.preventDefault();
    go(a.href);
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    if (form.hasAttribute('data-native')) return;
    e.preventDefault();
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    var action = form.getAttribute('action') || window.location.pathname;
    var data = new FormData(form);
    if (e.submitter && e.submitter.name) data.append(e.submitter.name, e.submitter.value);
    if (method === 'get') {
      var qs = new URLSearchParams();
      data.forEach(function (v, k) { if (typeof v === 'string' && v !== '') qs.append(k, v); });
      var s = qs.toString();
      go(action.split('?')[0] + (s ? '?' + s : ''));
      return;
    }
    // Signing in: ask for full screen now, while the browser still counts this as the user's own action.
    if (form.closest('.signin') && /\/login$/.test(action)) enterFullscreen();
    var multipart = (form.getAttribute('enctype') || '').toLowerCase() === 'multipart/form-data';
    go(action, { method: 'POST', body: multipart ? data : new URLSearchParams(data) });
  });

  window.addEventListener('popstate', function () { go(window.location.href, { push: false }); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    root.classList.remove('nav-open');
    document.querySelectorAll('details.menu[open]').forEach(function (m) { m.open = false; });
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    // An enrolment photo was chosen: make it a JPEG and show it.
    var shot = t.matches('input[type=file]') ? t.closest('[data-shot]') : null;
    if (shot && t.files && t.files[0] && !t._converting) {
      var original = t.files[0];
      toJpeg(original, (original.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg').then(function (file) {
        if (file) { t._converting = true; setShot(shot, file); t._converting = false; }
        else { t.value = ''; window.alert('That file is not a picture this browser can read. Choose a JPEG photo.'); }
      });
      return;
    }
    // Permission matrix: edit, delete and export need view.
    if (t.matches('.matrix input[type=checkbox]')) {
      var boxes = document.querySelectorAll('.matrix input[data-cell="' + t.getAttribute('data-cell') + '"]');
      var view = Array.prototype.find.call(boxes, function (b) { return b.getAttribute('data-action') === 'view'; });
      if (t.getAttribute('data-action') !== 'view' && t.checked && view) view.checked = true;
      if (t.getAttribute('data-action') === 'view' && !t.checked) boxes.forEach(function (b) { b.checked = false; });
    }
    // Filters apply as soon as a box changes.
    var auto = t.closest('form[data-auto]');
    if (auto) { if (auto.requestSubmit) auto.requestSubmit(); else auto.submit(); }
  });

  initPage();
})();
