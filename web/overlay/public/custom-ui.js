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

    /* 触屏判定：媒体查询在部分内嵌浏览器（包括桌面客户端里的 webview）不可靠，
     * 自己判一次挂到 <html> 上，CSS 只认这个类。 */
    function detectPointer() {
        var touch = false;
        try {
            // 触屏判定要稳：手机 PWA 里 matchMedia 有时只报 hover:none、不报 pointer，
            // 光看 pointer:coarse 会漏判 → 被当成桌面，布局就挤到左边去了。
            // 所以：没有精确指针(fine) 且（粗指针 或 有多点触控/ontouchstart）就算触屏。
            var fine = window.matchMedia('(pointer: fine)').matches;
            var coarse = window.matchMedia('(pointer: coarse)').matches;
            var hasTouch = (navigator.maxTouchPoints || 0) > 0 || ('ontouchstart' in window);
            touch = !fine && (coarse || hasTouch);
        } catch (e) {}
        root.classList.toggle('x-touch', !!touch);
    }

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
        var btn = host && host.querySelector('.x-tool[data-x="full"]');
        if (btn) btn.setAttribute('title', on ? '退出全屏' : '全屏');
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
    /* 右侧工具栏现在盖在画面上（absolute、贴页面右边），算可用宽度时要让出它的
     * 宽度，否则 canvas 会被那条按钮栏压住一条。滑出隐藏时不占位。 */
    function controlBarWidth(dlg) {
        var cw = dlg.querySelector('.control-buttons-list');
        if (!cw) return 0;
        // 触屏设备工具栏默认是滑出隐藏的，不占画面宽度
        if (root.classList.contains('x-touch') && !root.classList.contains('x-side')) return 0;
        var cs = getComputedStyle(cw);
        if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
        var r = cw.getBoundingClientRect();
        if (cs.position !== 'absolute' || r.width <= 0) return 0;
        if (r.left >= window.innerWidth - 2) return 0;   // 已滑出视口
        return r.width;
    }

    /* 桌面弹窗宽度 = 画面 + 工具栏：把工具栏宽度写成 device-view 的右内边距，
     * 工具栏（absolute right:0）正好落在留白里，不会压住画面。 */
    function fitDialogWidth(dlg) {
        dlg = dlg || host;
        if (!dlg) return;
        var dv = dlg.querySelector('.device-view');
        if (!dv) return;
        // 触屏：让位交给 CSS 的 safe-area（env），这里别写 inline padding ——
        // inline !important 会把安全区覆盖成 0，画面底部就被 iPhone 圆角啃掉。
        if (root.classList.contains('x-touch')) {
            dv.style.removeProperty('padding-right');
            dv.style.removeProperty('padding-bottom');
            return;
        }
        var cw = dlg.querySelector('.control-buttons-list');
        var land = root.classList.contains('x-land');
        var barW = 0, barH = 0;
        if (cw) {
            // 横屏时厚度是 CSS 写死的 BAR_THICK：不能去量它自己的高度（height 由
            // 这个 padding 决定，互相喂就会越算越大）。
            if (land) barH = BAR_THICK;
            else barW = controlBarWidth(dlg) || Math.round(cw.getBoundingClientRect().width) || BAR_THICK;
        }
        var pr = barW ? barW + 'px' : '0px';
        var pb = barH ? barH + 'px' : '0px';
        if (dv.style.getPropertyValue('padding-right') !== pr) dv.style.setProperty('padding-right', pr, 'important');
        if (dv.style.getPropertyValue('padding-bottom') !== pb) dv.style.setProperty('padding-bottom', pb, 'important');
    }

    /* 弹窗盒子直接写成「画面 + 工具栏」的像素尺寸。靠 CSS fit-content 也行，
     * 但全屏（PWA）下 fixed 的 dialog 和 fixed 的 frame 会互相认不出来、算成 0 宽，
     * 所以这里用真尺寸兜底，全屏/窗口一个算法。 */
    function fitDialogBox(dlg) {
        dlg = dlg || host;
        if (!dlg) return;
        // 手机/平板（x-touch）是满屏滑出式工具栏，尺寸交给 CSS（100dvw/100dvh）。
        // 这里要是写了 inline 像素尺寸，会把手机端挤成桌面那种窄条。
        if (root.classList.contains('x-touch')) {
            if (dlg.style.getPropertyValue('width')) dlg.style.removeProperty('width');
            if (dlg.style.getPropertyValue('height')) dlg.style.removeProperty('height');
            return;
        }
        var c = dlg.querySelector('canvas.video-layer') || dlg.querySelector('.video-layer');
        var cw = dlg.querySelector('.control-buttons-list');
        if (!c) return;
        var cwid = Math.round(parseFloat(c.style.width) || c.getBoundingClientRect().width || 0);
        var chgt = Math.round(parseFloat(c.style.height) || c.getBoundingClientRect().height || 0);
        if (!cwid || !chgt) return;
        var land = root.classList.contains('x-land');
        var hideBar = root.classList.contains('x-touch') && !root.classList.contains('x-side');
        var barW = hideBar ? 0 : (land ? 0 : (Math.round(cw.getBoundingClientRect().width) || BAR_THICK));
        var barH = hideBar ? 0 : (land ? BAR_THICK : 0);
        var headerH = 0;
        var hd = dlg.querySelector('.modal-header');
        if (hd) {
            var hds = getComputedStyle(hd);
            if (hds.display !== 'none' && hds.visibility !== 'hidden') {
                headerH = Math.round(hd.getBoundingClientRect().height || 0);
            }
        }
        var w = cwid + barW + 2;      // +2 是 modal-frame 那 1px 边框
        var h = chgt + barH + headerH + 2;
        if (dlg.style.getPropertyValue('width') !== w + 'px') dlg.style.setProperty('width', w + 'px', 'important');
        if (dlg.style.getPropertyValue('height') !== h + 'px') dlg.style.setProperty('height', h + 'px', 'important');
    }

    /* 横排工具栏的厚度（横屏时工具栏在画面下方）。CSS 里高度固定 BAR_THICK，
     * 拿不到真实盒子时用它兜底。 */
    var BAR_THICK = 58;
    function controlBarThick() {
        if (root.classList.contains('x-touch') && !root.classList.contains('x-side')) return 0;
        return BAR_THICK;
    }

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
        if (false) {
            var vr = video.getBoundingClientRect();
            availW = Math.floor(Math.min(vr.width || window.innerWidth, window.innerWidth) - controlBarWidth(dlg));
            availH = Math.floor(Math.min((vr.height || window.innerHeight) - padT - padB, window.innerHeight));
        } else {
            // 窗口模式：.video 的高度是「跟着 canvas 走」的，量它会形成
            // canvas 变小 → 盒子变小 → canvas 更小的死循环。所以量 modal-body：
            // 它的高度由弹窗盒子定（不依赖 canvas），扣掉 padding 就是可用高度。
            // 一律用视口算：标题栏可见时扣掉它的高度，全屏（x-full）时它 display:none。
            // 别去量 .video / .modal-body —— 那两个盒子的尺寸是我们自己改 canvas 撑出来的，
            // 量它们就成循环（早先画面被裁、被拉伸都是这个原因）。
            var headerH = 0;
            var hd = dlg.querySelector('.modal-header');
            if (hd) {
                var hds = getComputedStyle(hd);
                if (hds.display !== 'none' && hds.visibility !== 'hidden') {
                    headerH = hd.getBoundingClientRect().height || 0;
                }
            }
            availW = Math.floor(window.innerWidth - controlBarWidth(dlg));
            availH = Math.floor(window.innerHeight - headerH);
        }
        // 触屏（手机）：扣掉安全区（刘海/圆角/home indicator），否则画面底部会被啃掉
        if (root.classList.contains('x-touch')) {
            var dv2 = dlg.querySelector('.device-view');
            if (dv2) {
                var dcs = getComputedStyle(dv2);
                availW = Math.floor(availW - (parseFloat(dcs.paddingLeft) || 0) - (parseFloat(dcs.paddingRight) || 0));
                availH = Math.floor(availH - (parseFloat(dcs.paddingTop) || 0) - (parseFloat(dcs.paddingBottom) || 0));
            }
        }
        if (availW < 2 || availH < 2) return;
        /* 自动转向：源是横屏（游戏）而我们是竖屏看 → 把画面整体转 90°，
         * 手机不用横过来也能满屏。转了之后可视宽高互换，所以缩放比要反过来算。 */
        /* 不设尺寸上限：按画面比例把可用空间吃满（窗口缩小/放大，画面跟着等比缩放大）。
         * 主人要的是"能多大多大"，不是钉死一个值——早先设过 900/1:1 上限，
         * 在他的竖屏显示器上就只占半边、看着像"固定不能调"。 */
        var rot = rotJustify(bw, bh);
        // x-land（工具栏横排到画面下方）只给桌面用；手机上工具栏还是滑出式，
        // 横屏时画面按比例铺满整屏就行。
        var land = !rot && bw > bh && !root.classList.contains('x-touch');
        if (land !== root.classList.contains('x-land')) root.classList.toggle('x-land', land);
        if (land) {
            // 工具栏横排在画面下面：宽度吃满视口，高度要让出那一条
            availW = Math.floor(window.innerWidth);
            availH = Math.floor(availH - controlBarThick());
            if (availH < 40) availH = Math.floor(window.innerHeight - BAR_THICK - 49);
            if (root.classList.contains('x-touch') && root.classList.contains('x-side')) {
                availW = Math.floor(window.innerWidth);
            }
        }
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
        if (rot !== root.classList.contains('x-rot')) root.classList.toggle('x-rot', rot);
        applyRotate(c, rot);
        fitDialogWidth(dlg);
        fitDialogBox(dlg);
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
        /* 两头的要求不一样，别再一刀切：
         *   · 手机（x-touch）：横屏内容**转 90°** 铺满竖着拿的屏幕——画面大小跟竖屏时一样，
         *     只是内容横过来（歪头看）。这就是主人说的「像竖屏一样的画面大小，只不过画面变横」。
         *   · 桌面：不转，横着放 + 工具栏在下方（他要的是这个）。
         * localStorage 的 x-ui-rot 可以强制关（'0'）或强制开（'1'）。 */
        var auto = bw > bh && window.innerHeight > window.innerWidth;
        var mode = null;
        try { mode = localStorage.getItem(ROT_KEY); } catch (e) {}
        if (mode === '0') return false;
        if (mode === '1') return auto;
        return root.classList.contains('x-touch') ? auto : false;
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

    /* 手机转横屏玩游戏时，播放器会把 canvas 的内部像素尺寸换掉（720x1600 → 1600x720），
     * 但 CSS 盒子已经被我们钉死了，ResizeObserver 看不到变化 → 画面一直按竖屏摆。
     * 每 500ms 比一次内部尺寸，变了就重新按新比例铺。 */
    var lastSrcW = 0, lastSrcH = 0;
    function checkSourceSize() {
        var dlg = host;
        if (!dlg) return;
        var c = dlg.querySelector('canvas.video-layer') || dlg.querySelector('.video-layer');
        if (!c || !c.width || !c.height) return;
        if (c.width === lastSrcW && c.height === lastSrcH) return;
        lastSrcW = c.width;
        lastSrcH = c.height;
        pinCanvas();
    }

    function keepTouchInSync() {
        if (touchTimer) return;
        touchTimer = setInterval(function () {
            if (!host) { clearInterval(touchTimer); touchTimer = null; return; }
            if (!touchObserver) watchCanvas();   // canvas 是后出现的，出现后再挂观察者
            syncTouch();
            if (host) buildTools(host);
            checkSourceSize();
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

    /* 三个工具按钮不单独飘一层：塞进右侧那条工具栏（ws-scrcpy 自带），
     * 一列到底，免得两套按钮重影。截图键也在这里换成「手机截图」。 */
    function buildTools(dlg) {
        var cw = dlg.querySelector('.control-buttons-list');
        if (!cw) return null;
        if (cw.getAttribute('data-x-tools') === '1') return cw;
        cw.setAttribute('data-x-tools', '1');

        // 图标跟原生那条一样用 Material SVG（原生是 48 格 viewBox 的实心 path），
        // 纯字符会因为字体不同显得又细又淡，跟下面一排对不上。
        // 和原生按钮一模一样的规格：48 格 viewBox + width/height 48 + 同一条
        // currentColor 描边。少了这些，图标会比下面那排又细又小（看得出是外挂的）。
        // 用 rect 直接画几何形状：路径缩放过的那种在 30px 下四个拐角会被
        // 抗锯齿啃圆，看着像"不是正方形"。rect 是边缘对齐的纯直角。
        var ICONS = {
            full: '<rect x="10" y="10" width="12" height="4"/><rect x="10" y="10" width="4" height="12"/>'
                + '<rect x="26" y="10" width="12" height="4"/><rect x="34" y="10" width="4" height="12"/>'
                + '<rect x="10" y="34" width="12" height="4"/><rect x="10" y="26" width="4" height="12"/>'
                + '<rect x="26" y="34" width="12" height="4"/><rect x="34" y="26" width="4" height="12"/>',
            side: '<rect x="8" y="13" width="32" height="4"/>'
                + '<rect x="8" y="22" width="32" height="4"/>'
                + '<rect x="8" y="31" width="32" height="4"/>',
            close: '<path d="M38 12.83L35.17 10 24 21.17 12.83 10 10 12.83 21.17 24 10 35.17 12.83 38 24 26.83 35.17 38 38 35.17 26.83 24z"/>',
        };
        function mk(k, title) {
            var b = document.createElement('button');
            b.className = 'control-button x-tool';
            b.setAttribute('data-x', k);
            b.setAttribute('title', title);
            b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" '
                + 'shape-rendering="crispEdges"><path fill="none" d="M0 0h48v48H0z"></path>'
                + ICONS[k] + '</svg>';
            return b;
        }

        // 放最上面：不用滚到底才点得到，也不会贴着手机 Dock 误触
        cw.insertBefore(mk('close', '关闭会话'), cw.firstChild);
        cw.insertBefore(mk('side', '显示 / 隐藏工具栏'), cw.firstChild);
        cw.insertBefore(mk('full', '全屏 / 退出全屏'), cw.firstChild);

        cw.addEventListener('click', function (ev) {
            var b = ev.target.closest('.x-tool');
            if (!b) return;
            ev.preventDefault();
            ev.stopPropagation();
            var k = b.getAttribute('data-x');
            if (k === 'full') applyFull(!root.classList.contains('x-full'));
            if (k === 'side') applySide(!root.classList.contains('x-side'));
            if (k === 'close') { applySide(false); closeModal(); }
        }, true);
        cw.addEventListener('touchstart', function (ev) {
            if (ev.target.closest('.x-tool')) ev.stopPropagation();
        }, { passive: true });

        hookShot(cw);
        return cw;
    }

    /* ── 截图：改成 vivo 自己的截图（存进手机相册）────────────────────────
     * ws-scrcpy 自带的 Take screenshot 走的是 scrcpy 控制通道，页面模式下发不出去。
     * 这里把原按钮藏起来、换一个同图标的按钮，点击打投屏门的 /x/screenshot，
     * 由后端 adb screencap 存到手机 DCIM/Screenshots 并通知相册。 */
    function toast(msg) {
        var t = document.querySelector('.x-toast');
        if (!t) {
            t = document.createElement('div');
            t.className = 'x-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('x-toast-show');
        clearTimeout(t.xTimer);
        t.xTimer = setTimeout(function () { t.classList.remove('x-toast-show'); }, 2600);
    }

    function takeShot(btn) {
        if (btn.getAttribute('data-busy') === '1') return;
        btn.setAttribute('data-busy', '1');
        btn.classList.add('x-busy');
        var done = function () {
            btn.removeAttribute('data-busy');
            btn.classList.remove('x-busy');
        };
        fetch('/x/screenshot', { method: 'POST', cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                toast(d && d.ok ? '已截图并存入手机相册' : ('截图失败：' + ((d && d.error) || '未知错误')));
                done();
            })
            .catch(function (e) { toast('截图失败：' + e.message); done(); });
    }

    function hookShot(cw) {
        var orig = cw.querySelector('button[title="Take screenshot"]')
            || cw.querySelector('button[title*="creenshot"]');
        if (!orig || orig.getAttribute('data-x-shot') === '1') return;
        orig.setAttribute('data-x-shot', '1');
        orig.style.display = 'none';
        var b = document.createElement('button');
        b.className = 'control-button x-shot';
        b.setAttribute('title', '截图（直接存到手机相册）');
        b.innerHTML = orig.innerHTML;
        b.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            takeShot(b);
        }, true);
        b.addEventListener('touchstart', function (ev) { ev.stopPropagation(); }, { passive: true });
        orig.parentNode.insertBefore(b, orig.nextSibling);
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

    detectPointer();
    window.addEventListener('resize', function () { detectPointer(); watchCanvas(); keepTouchInSync(); });
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
            buildTools(dlg);
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

/* ---- 音频体检 HUD：地址带 ?hud=1 才显示，用于判断“没声音”卡在哪一环 ---- */
(function () {
  if (!/[?&]hud=1/.test(location.search)) return;
  var box = document.createElement('div');
  box.id = 'x-audio-hud';
  box.style.cssText =
    'position:fixed;left:10px;bottom:10px;z-index:10000;padding:8px 12px;border-radius:8px;' +
    'background:rgba(0,0,0,.82);color:#8ef;font:13px/1.6 ui-monospace,monospace;white-space:pre;' +
    'pointer-events:none;max-width:60vw';
  document.documentElement.appendChild(box);
  setInterval(function () {
    var peak = window.__xAudioPeak;
    var buf = window.__xAudioBufferMs;
    var under = window.__xAudioUnderruns;
    var keeper = window.__xAudioKeeper;
    box.textContent =
      'ctx  ' + (window.__xAudioCtxState || '-') + '\n' +
      'peak ' + (peak === undefined ? '没有音频在解' : peak + '/1000') + '\n' +
      'buf  ' + (buf === undefined ? '-' : buf + 'ms') + '   断粮 ' + (under === undefined ? '-' : under) + '\n' +
      'keeper ' + (keeper ? (keeper.paused ? '暂停' : '在放') : '无');
  }, 500);
})();
