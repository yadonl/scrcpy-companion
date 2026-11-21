/* 小月的投屏增强层：全屏 / 侧栏隐藏式
 * 纯 DOM 外挂，不改应用内部逻辑；只依赖 dialog.connect-modal 的类名。
 *
 * 关键：投屏界面是 <dialog>，浏览器把 showModal() 的 dialog 提升到 top layer，
 * z-index 再大也压不过它 —— 所以工具条/热区必须挂在 dialog 里面，不能挂 body。 */
(function () {
    'use strict';

    var LS_FULL = 'x-ui-full';
    var ROT_KEY = 'x-ui-rot';
    var root = document.documentElement;
    var host = null;   // 当前 dialog
    var bar = null;

    function dialogEl() {
        var list = document.querySelectorAll('dialog.connect-modal');
        for (var i = 0; i < list.length; i++) {
            if (list[i].open || list[i].hasAttribute('open')) return list[i];
        }
        return null;
    }

    function applyFull(on) {
        root.classList.toggle('x-full', !!on);
        try { localStorage.setItem(LS_FULL, on ? '1' : '0'); } catch (e) {}
        var btn = bar && bar.querySelector('[data-x="full"]');
        if (btn) btn.setAttribute('title', on ? 'exit fullscreen' : 'fullscreen');
        var meta = document.querySelector('meta[name="viewport"]');
        if (meta) {
            meta.setAttribute('content', on
                ? 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no'
                : 'width=device-width, initial-scale=1.0');
        }
        syncTouch();
        if (on) startFullFitTimer();
        // 全屏是纯 CSS 改盒子尺寸，不会触发 window resize；播放器不重排就会继续
        // 按旧尺寸画，画面比容器小一圈。手动捅一下让它重新量。
        window.setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 50);
    }

    /* 触摸坐标是按「触摸层」自己的矩形换算成设备像素的（InteractionHandler 用
     * target.getBoundingClientRect() + clientWidth/Height），所以触摸层必须和画面
     * 尺寸严格一致 —— 全屏铺开时 canvas 由 CSS 撑满、触摸层不跟，就会出现“点这里
     * 打到上面去”的漂移。这里把触摸层钉成和 canvas 同尺寸。 */
    var touchTimer = null;
    var touchObserver = null;

    function syncTouch() {
        pinCanvas();
        var dlg = host;
        if (!dlg) return;
        var c = dlg.querySelector('canvas.video-layer') || dlg.querySelector('.video-layer');
        var t = dlg.querySelector('.touch-layer');
        if (!c || !t) return;
        /* 用 clientWidth/clientHeight（布局尺寸，不含 transform），否则转了 90°
         * 之后 getBoundingClientRect 拿到的是包围盒，宽高互换，触摸层会歪。 */
        var w = Math.round(c.clientWidth);
        var h = Math.round(c.clientHeight);
        if (!w || !h) return;
        var rot = c.getAttribute('data-x-rot') === '90';
        var same = t.style.width === w + 'px' && t.style.height === h + 'px'
            && (t.getAttribute('data-x-rot') === '90') === rot
            && (!rot || t.style.getPropertyValue('left') === c.style.getPropertyValue('left'));
        if (same) return;
        t.style.maxWidth = 'none';
        t.style.maxHeight = 'none';
        t.style.width = w + 'px';
        t.style.height = h + 'px';
        if (rot) {
            t.style.setProperty('position', 'relative', 'important');
            t.style.setProperty('left', c.style.getPropertyValue('left') || '0px', 'important');
        } else {
            t.style.removeProperty('left');
            t.style.removeProperty('position');
        }
        applyRotate(t, rot);
    }

    /* 「像素点没对准」的根因：canvas 的 CSS 尺寸是 calc(100dvh-52px) 这种小数，
     * 浏览器把 1072x2400 的位图采样到 334.3x748.3 个 CSS 像素上，再乘设备像素比，
     * 得到一个非整数缩放 —— 字边永远在半个像素之间，看起来就是糊+发虚。
     * 这里按整数 CSS 像素重新钉一遍（inline !important 压过样式表），
     * 缩放比就落在 1:1 附近，画面立刻实。
     *
     * 曾经这里写死 `innerHeight - 52`：全屏时 .video 已经不再留 52px，画面却还按
     * 792 高画，结果四周多出一圈黑边 —— 用户看到的就是“点了全屏还是没铺满”。
     * 现在按 .video 的真实盒子（扣掉它自己的安全区 padding）算。
     */
    function pinCanvas() {
        var dlg = host;
        if (!dlg) return;
        var c = dlg.querySelector('canvas.video-layer') || dlg.querySelector('.video-layer');
        if (!c) return;
        var bw = c.width, bh = c.height;
        if (!bw || !bh) return;
        var video = dlg.querySelector('.video');
        var padT = 0, padB = 0;
        if (video) {
            var vcs = getComputedStyle(video);
            padT = parseFloat(vcs.paddingTop) || 0;
            padB = parseFloat(vcs.paddingBottom) || 0;
        }
        var availW, availH;
        if (root.classList.contains('x-full') && video) {
            // 全屏：.video 是 100dvh 死高，量它不会反过来影响自己 —— 安全
            var vr = video.getBoundingClientRect();
            availW = Math.floor(Math.min(vr.width || window.innerWidth, window.innerWidth));
            availH = Math.floor(Math.min((vr.height || window.innerHeight) - padT - padB, window.innerHeight));
        } else {
            // 窗口模式：.video 的高度是「跟着 canvas 走」的，量它会形成
            // canvas 变小 → 盒子变小 → canvas 更小的死循环，只能用视口近似。
            availW = Math.floor(window.innerWidth);
            availH = Math.floor(window.innerHeight - 52);
        }
        if (availW < 2 || availH < 2) return;
        /* 自动转向：源是横屏（游戏）而我们是竖屏看 → 把画面整体转 90°，
         * 手机不用横过来也能满屏。转了之后可视宽高互换，所以缩放比要反过来算。 */
        var rot = rotJustify(bw, bh);
        var s = rot
            ? Math.min(availH / bw, availW / bh)
            : Math.min(availW / bw, availH / bh);
        var w = Math.max(1, Math.round(bw * s));
        var h = Math.max(1, Math.round(bh * s));
        if (c.style.getPropertyValue('width') !== w + 'px') {
            c.style.setProperty('width', w + 'px', 'important');
        }
        if (c.style.getPropertyValue('height') !== h + 'px') {
            c.style.setProperty('height', h + 'px', 'important');
        }
        c.style.setProperty('max-width', 'none', 'important');
        c.style.setProperty('max-height', 'none', 'important');
        /* 转 90° 后布局盒是「未旋转的横条」（844x377），比竖屏宽得多。Chromium 的
         * grid 对齐对「超出格子」的元素会退化成起始对齐，结果画面整体右移、右边被裁。
         * 用 position:relative + left 把盒子摆回正中（transform-origin 跟着盒子走，
         * 所以旋转后的画面也跟着居中）。 */
        if (rot) {
            c.style.setProperty('position', 'relative', 'important');
            c.style.setProperty('left', Math.round((availW - w) / 2) + 'px', 'important');
        } else {
            c.style.removeProperty('left');
            c.style.removeProperty('position');
        }
        applyRotate(c, rot);
    }

    /* 播放器自己会写 transform: scale(x)（origin: top left），所以这里只能在它
     * 基础上再串一个 rotate，不能用 style.transform = 覆盖掉。 */
    function applyRotate(el, rot) {
        if (!el) return;
        var cur = el.style.transform || '';
        var sc = cur.match(/scale\(([\d.]+)\)/);
        var base = sc ? 'scale(' + sc[1] + ')' : '';
        if (rot) {
            el.style.setProperty('transform', (base ? base + ' ' : '') + 'rotate(90deg)', 'important');
            el.style.setProperty('transform-origin', 'center center', 'important');
            el.setAttribute('data-x-rot', '90');
        } else {
            if (base) {
                el.style.setProperty('transform', base, 'important');
            } else {
                el.style.removeProperty('transform');
            }
            el.style.removeProperty('transform-origin');
            el.removeAttribute('data-x-rot');
        }
    }

    function rotJustify(bw, bh) {
        try {
            if (localStorage.getItem(ROT_KEY) === '0') return false;
        } catch (e) {}
        return bw > bh && window.innerHeight > window.innerWidth;
    }

    /* canvas 的尺寸会被播放器改（分辨率变化、旋转、进出全屏），只靠定时器会漏，
     * 用 ResizeObserver 常驻盯着，尺寸一变就把触摸层拽过去。 */
    function watchCanvas() {
        var dlg = host;
        if (!dlg) return;
        var c = dlg.querySelector('canvas.video-layer') || dlg.querySelector('.video-layer');
        if (!c) return;
        if (touchObserver) { try { touchObserver.disconnect(); } catch (e) {} touchObserver = null; }
        if (typeof ResizeObserver !== 'undefined') {
            touchObserver = new ResizeObserver(function () { syncTouch(); });
            touchObserver.observe(c);
        }
        syncTouch();
    }

    function keepTouchInSync() {
        if (touchTimer) return;
        touchTimer = setInterval(function () {
            if (!host) { clearInterval(touchTimer); touchTimer = null; return; }
            if (!touchObserver) watchCanvas();   // canvas 是后出现的，出现后再挂观察者
            syncTouch();
        }, 500);
    }

    function stopTouchSync() {
        if (touchTimer) { clearInterval(touchTimer); touchTimer = null; }
        if (touchObserver) { try { touchObserver.disconnect(); } catch (e) {} touchObserver = null; }
    }

    function applySide(on) {
        root.classList.toggle('x-side', !!on);
    }

    /* 侧栏（右侧工具面板）的关闭逻辑：
     * 原来只有一个隐藏方式 —— 点底部工具条的 ☰，而且点画面关不掉，因为画面上面
     * 盖着 touch-layer，它把 touchstart/touchend 都吃掉、不产生 click，文档上的
     * click 监听永远收不到。这里补两个符合直觉的出口：
     *   ① 半透明遮罩：侧栏展开时铺满画面，点一下就收起；
     *   ② 右侧那条隐藏拉手：再点一次就是「收起」。
     */
    function buildBackdrop(dlg) {
        if (dlg.querySelector('.x-side-backdrop')) return;
        var b = document.createElement('div');
        b.className = 'x-side-backdrop';
        var close = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            applySide(false);
        };
        b.addEventListener('touchstart', close, { passive: false });
        b.addEventListener('mousedown', close, true);
        b.addEventListener('click', close, true);
        dlg.appendChild(b);
    }

    /* 全屏后尺寸要「盯一会儿」：进流那一刻 .video 可能还是旧盒子，pinCanvas 会把
     * 画面钉小，而之后没有任何事件把它改回来（用户看到的就是四周一圈黑边）。
     * 全屏期间每 500ms 重算一次，最多盯 20 秒。 */
    var fullFitTimer = null;
    function startFullFitTimer() {
        if (fullFitTimer) return;
        var n = 0;
        fullFitTimer = setInterval(function () {
            n++;
            if (!root.classList.contains('x-full') || !host || n > 40) {
                clearInterval(fullFitTimer);
                fullFitTimer = null;
                return;
            }
            pinCanvas();
        }, 500);
    }

    /* 主屏图标打开（standalone）时没有地址栏，用户期待的就是满屏 */
    function isStandalone() {
        try {
            if (window.navigator.standalone === true) return true;
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
            if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
        } catch (e) {}
        return false;
    }

    function closeModal() {
        if (!host) return;
        var x = host.querySelector('.modal-header-controls .modal-close:last-of-type') ||
                host.querySelector('.modal-close');
        if (x) { x.click(); return; }
        try { host.close(); } catch (e) {}
    }

    function buildBar(dlg) {
        if (bar && bar.parentElement === dlg) return bar;
        bar = document.createElement('div');
        bar.className = 'x-ui-bar';
        bar.innerHTML =
            '<button data-x="full" title="fullscreen">\u26F6</button>' +
            '<button data-x="side" title="controls">\u2630</button>' +
            '<button data-x="close" title="close">\u2715</button>';
        bar.addEventListener('click', function (ev) {
            var b = ev.target.closest('button');
            if (!b) return;
            ev.preventDefault();
            ev.stopPropagation();
            var k = b.getAttribute('data-x');
            if (k === 'full') applyFull(!root.classList.contains('x-full'));
            if (k === 'side') applySide(!root.classList.contains('x-side'));
            if (k === 'close') { applySide(false); closeModal(); }
        }, true);
        bar.addEventListener('touchstart', function (ev) { ev.stopPropagation(); }, { passive: true });
        dlg.appendChild(bar);
        return bar;
    }

    function buildEdge(dlg) {
        if (dlg.querySelector('.x-edge-handle')) return;
        var h = document.createElement('div');
        h.className = 'x-edge-handle';
        h.addEventListener('touchstart', function (e) {
            e.stopPropagation();
            e.preventDefault();
        }, { passive: false });
        h.addEventListener('touchend', function (e) {
            e.stopPropagation();
            applySide(!root.classList.contains('x-side'));
        });
        h.addEventListener('click', function (e) {
            e.stopPropagation();
            applySide(!root.classList.contains('x-side'));
        });
        dlg.appendChild(h);
    }

    /* 侧栏展开时，点画面区域就收起 */
    document.addEventListener('click', function (ev) {
        if (!root.classList.contains('x-side')) return;
        if (ev.target.closest('.control-buttons-list, .x-ui-bar, .x-edge-handle')) return;
        applySide(false);
    }, true);

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') applySide(false);
    });

    window.addEventListener('resize', function () { watchCanvas(); keepTouchInSync(); });
    window.addEventListener('orientationchange', function () {
        setTimeout(function () { watchCanvas(); keepTouchInSync(); }, 300);
    });

    var lastOpen = false;
    function sync() {
        var dlg = dialogEl();
        var open = !!dlg;
        root.classList.toggle('is-streaming', open);
        if (open) {
            host = dlg;
            buildBar(dlg);
            buildEdge(dlg);
            buildBackdrop(dlg);
            if (!lastOpen) {
                var want = false;
                try { want = localStorage.getItem(LS_FULL) === '1'; } catch (e) {}
                // 主屏 PWA（无地址栏）里默认就全屏：主人要的本来就是"打开就是满屏"
                if (!want && isStandalone()) want = true;
                applyFull(want);
                applySide(false);
            }
            watchCanvas();
            keepTouchInSync();
        } else if (lastOpen) {
            applySide(false);
            stopTouchSync();
            bar = null;
            host = null;
        }
        lastOpen = open;
    }

    var mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('DOMContentLoaded', sync);
    sync();
})();
