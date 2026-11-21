/**
 * 外网连接自动降档。
 *
 * 背景：家里宽带上行实测约 **74Mbps**（2026-11-20 早上 4 条流并行实测合计），
 * 20Mbps 单流放得下。之前注释里写的"上行 6.7Mbps"没有出处，已更正。
 * 手机编码端不知道这件事，
 * 前端默认 12Mbps / 2400 长边 / 60fps，一出内网就比上行管道还粗 → TCP 队列越堆越长，
 * 表现就是画面卡死 + 延迟抖到 200ms 以上。
 *
 * 规则：客户端不在内网（非回环、非 RFC1918）时，把码率/长边/帧率压到上行能承受的范围；
 * 内网客户端保持用户设置不动。用环境变量可调：
 *   WAN_MAX_BITRATE(默认 3000000) WAN_MAX_SIZE(默认 1600) WAN_MAX_FPS(默认 30)
 *   WAN_PROFILE_OFF=1 完全关闭
 *
 * 判断真实来源要过三关，因为访问都经过反代：
 *   1) X-Forwarded-For —— 9443 网关会写；tailscale serve 也可能写
 *   2) Host 是 *.ts.net —— tailscale serve 一定用这个域名，而它把来源变成 127.0.0.1
 *   3) socket 地址 —— 直连时最可靠
 */

type ReqLike = {
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string | undefined };
};

const TS_CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

const RFC1918 = [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^127\./,
    /^169\.254\./,
    /^::1$/,
    /^fe80:/i,
    /^fd7a:115c:a1e0:/i, // Tailscale ULA（若出现）
];

function header(req: ReqLike, name: string): string | undefined {
    const raw = req.headers[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    const first = v?.split(',')[0]?.trim();
    return first || undefined;
}

/** 这个地址算不算「家里内网」——算就不用降档。 */
export function isLanAddress(addr: string | undefined): boolean {
    if (!addr) return false;
    const a = addr.replace(/^::ffff:/, '');
    // Tailscale 100.64.0.0/10 走公网路径，不算内网
    if (TS_CGNAT.test(a)) return false;
    return RFC1918.some((re) => re.test(a));
}

/** 真实客户端地址：优先反代给的头，其次 socket。 */
export function clientAddress(req: ReqLike): string | undefined {
    return header(req, 'x-forwarded-for') ?? header(req, 'x-real-ip') ?? req.socket?.remoteAddress;
}

/**
 * 这次请求是不是从外网来的。
 *
 * 关键坑：反代（tailscale serve）把来源变成 127.0.0.1，如果先按「回环=内网」下结论，
 * 会永远判成局域网、降档永远不生效（实测日志里 xff=- host=*.ts.net sock=127.0.0.1）。
 * 所以回环只当「来源不可信」，改用 Host 判：*.ts.net 一定是外网入口。
 */
export function isWanRequest(req: ReqLike): { wan: boolean; why: string } {
    const addr = clientAddress(req)?.replace(/^::ffff:/, '');
    const loopback = !addr || addr === '::1' || addr === '127.0.0.1';
    if (!loopback && addr) {
        if (isLanAddress(addr)) return { wan: false, why: `LAN ${addr}` };
        if (TS_CGNAT.test(addr)) return { wan: true, why: `tailscale ${addr}` };
        return { wan: true, why: `WAN ${addr}` };
    }
    const host = (header(req, 'host') ?? '').toLowerCase();
    if (host.includes('.ts.net')) return { wan: true, why: `host ${host}` };
    return { wan: false, why: `loopback ${addr ?? '?'} host ${host || '-'}` };
}

function clampInt(params: URLSearchParams, key: string, max: number, fallback: number): void {
    const raw = params.get(key);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
    params.set(key, String(value));
}

/** 就地把参数压到外网档；返回是否生效。 */
export function applyWanProfile(params: URLSearchParams, remoteAddress: string | undefined): boolean {
    if (process.env['WAN_PROFILE_OFF'] === '1') return false;
    if (isLanAddress(remoteAddress)) return false;
    const bitrate = Number.parseInt(process.env['WAN_MAX_BITRATE'] ?? '3000000', 10);
    const maxSize = Number.parseInt(process.env['WAN_MAX_SIZE'] ?? '1600', 10);
    const maxFps = Number.parseInt(process.env['WAN_MAX_FPS'] ?? '30', 10);
    clampInt(params, 'bitrate', bitrate, bitrate);
    clampInt(params, 'maxSize', maxSize, maxSize);
    clampInt(params, 'maxFps', maxFps, maxFps);
    return true;
}

/** 按整个请求判外网并压档；返回判定依据，便于日志核对。 */
export function applyWanProfileForRequest(
    params: URLSearchParams,
    req: ReqLike,
): { applied: boolean; why: string } {
    const { wan, why } = isWanRequest(req);
    if (!wan) return { applied: false, why };
    return { applied: applyWanProfile(params, 'wan'), why };
}

/** iOS / iPadOS 判定（Safari 的 UA 里一定带 iPhone/iPad，iPadOS 13+ 伪装成 Mac） */
export function isIOSRequest(req: ReqLike): boolean {
    const ua = header(req, 'user-agent') ?? '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Macintosh/.test(ua) && /Mobile/i.test(ua);
}

/**
 * iPhone/iPad 走网页投屏时把分辨率压到屏幕实际需要的大小。
 *
 * 手机物理分辨率 1080x2400，但 Safari 视口只有 ~390pt 宽，按 3x 也就 1170 物理像素；
 * 推 2400 长边等于让手机解码 2 倍多无关像素，解码/绘制队列一长，观感就是"稳但不够跟手"。
 * 压到 1280 长边肉眼几乎无差，延迟和卡顿明显改善；码率同步封顶 8Mbps（这个分辨率够了）。
 *   IOS_MAX_SIZE(默认 1280) IOS_MAX_BITRATE(默认 8000000) IOS_PROFILE_OFF=1 关闭
 */
export function applyMobileProfile(
    params: URLSearchParams,
    req: ReqLike,
): { applied: boolean; why: string } {
    if (process.env['IOS_PROFILE_OFF'] === '1') return { applied: false, why: 'off' };
    if (!isIOSRequest(req)) return { applied: false, why: 'not ios' };
    const wan = isWanRequest(req).wan;
    // iOS 走 5G/外网时和办公电脑不是一回事：手机下行通常几十上百兆，
    // 真正紧的是家里的上行（~74Mbps）。所以手机外网单独一档，别被通用外网降档压死。
    const maxSize = Number.parseInt(
        process.env[wan ? 'IOS_WAN_MAX_SIZE' : 'IOS_MAX_SIZE'] ?? (wan ? '2400' : '2400'),
        10,
    );
    const maxBitrate = Number.parseInt(
        process.env[wan ? 'IOS_WAN_MAX_BITRATE' : 'IOS_MAX_BITRATE'] ?? (wan ? '12000000' : '16000000'),
        10,
    );
    const maxFps = Number.parseInt(
        process.env[wan ? 'IOS_WAN_MAX_FPS' : 'IOS_MAX_FPS'] ?? (wan ? '60' : '60'),
        10,
    );
    clampInt(params, 'maxSize', maxSize, maxSize);
    // 客户端（网页/手机 Safari）会把上次会话的码率缓存在本地，再带上来。
    // 只当上限用的话，服务端设 20M 也会被压回 12M —— 看起来"设置了没生效"。
    // 这里按档位直接拉满，码率永远以服务端档位为准。
    params.set('bitrate', String(maxBitrate));
    clampInt(params, 'maxFps', maxFps, maxFps);
    return { applied: true, why: `ios${wan ? '/wan' : ''} ${maxSize}/${maxBitrate}/${maxFps}` };
}
