<?php
// SYNC PLAYER — single-file PHP+JS app.
// Plays multiple audio files from a configured source folder synchronously
// using Web Audio API. Waveforms + decoded buffers cache in IndexedDB; encoded
// bytes use the browser HTTP cache (validated via Last-Modified).
//
// One deployment = one source. Pick + configure the adapter below.
// See AGENTS.md for architecture. Source navigation uses // ## name comments
// (no closing marker). The html-shell block uses #region/#endregion because
// build.php splices it by name when producing docs/index.html.

// ## php-config — defaults → config.php → SYNCPLAYER_* env, request validation
$audio_ext = ['mp3','m4a','aac','wav','ogg','oga','opus','flac','webm','weba'];

// Defaults — overridden by config.php (if present), then env vars (if set).
// See config.example.php for the file shape; SYNCPLAYER_* env vars are the
// last word, so YunoHost / Docker can override settings without editing files.
$cfg = [
    'adapter'           => 'local',
    'title'             => 'Sync Player',
    'app_password'      => '',
    'app_password_hint' => '',
    'nextcloud' => ['host' => '', 'token' => '', 'password' => '', 'password_hint' => '', 'can_write' => false],
    'local'     => ['root' => __DIR__ . '/public'],
];
if (is_file(__DIR__ . '/config.php')) {
    $cfg = array_replace_recursive($cfg, require __DIR__ . '/config.php');
}
// env overrides: [env var => path into $cfg]. Strings only; bools handled below.
foreach ([
    'SYNCPLAYER_ADAPTER'           => ['adapter'],
    'SYNCPLAYER_TITLE'             => ['title'],
    'SYNCPLAYER_APP_PASSWORD'      => ['app_password'],
    'SYNCPLAYER_APP_PASSWORD_HINT' => ['app_password_hint'],
    'SYNCPLAYER_NC_HOST'           => ['nextcloud', 'host'],
    'SYNCPLAYER_NC_TOKEN'          => ['nextcloud', 'token'],
    'SYNCPLAYER_NC_PASSWORD'       => ['nextcloud', 'password'],
    'SYNCPLAYER_NC_PASSWORD_HINT'  => ['nextcloud', 'password_hint'],
] as $env => $keys) {
    $v = getenv($env);
    if ($v === false || $v === '') continue;
    if (count($keys) === 1) $cfg[$keys[0]] = $v;
    else                    $cfg[$keys[0]][$keys[1]] = $v;
}
$ncCanWrite = getenv('SYNCPLAYER_NC_CAN_WRITE');
if ($ncCanWrite !== false && $ncCanWrite !== '') {
    $cfg['nextcloud']['can_write'] = filter_var($ncCanWrite, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? false;
}

$ADAPTER           = $cfg['adapter'];
$TITLE             = $cfg['title'];
$APP_PASSWORD      = $cfg['app_password'];
$APP_PASSWORD_HINT = $cfg['app_password_hint'];
$NEXTCLOUD         = $cfg['nextcloud'];
$LOCAL             = $cfg['local'];
$PWA_THEME_COLOR_LIGHT = '#f3ecdc';
$PWA_THEME_COLOR_DARK  = '#0e1116';
$APP_ICON_SVG_DARK = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='#0e1116'/><path d='M 50 22 A 28 28 0 1 1 22 50' fill='none' stroke='#ffb454' stroke-width='4' stroke-linecap='round'/><path d='M46 42 L58 50 L46 58 Z' fill='#ece4d0'/></svg>";
$APP_ICON_SVG_LIGHT = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='#f3ecdc'/><path d='M 50 22 A 28 28 0 1 1 22 50' fill='none' stroke='#c8410a' stroke-width='4' stroke-linecap='round'/><path d='M46 42 L58 50 L46 58 Z' fill='#15110a'/></svg>";
$APP_ICON_DARK     = 'data:image/svg+xml,' . rawurlencode($APP_ICON_SVG_DARK);
$APP_ICON_LIGHT    = 'data:image/svg+xml,' . rawurlencode($APP_ICON_SVG_LIGHT);
$APP_ICON_MANIFEST = '?mode=icon';

header("Content-Security-Policy: frame-ancestors 'self'");
header('X-Robots-Tag: noindex, nofollow');

$path = $_GET['path'] ?? '/';
foreach (explode('/', $path) as $seg) if ($seg === '..') { http_response_code(400); exit('Invalid path'); }

$password = (string)($_GET['password'] ?? $_POST['password'] ?? '');
if (strlen($password) > 256) { http_response_code(400); exit('Invalid password'); }

// App-level gate. Endpoints reject with 401 + hint when the pw doesn't match.
// The HTML shell is intentionally not gated — it carries no data; the JS will
// trigger the 401 on its first ?mode=list call, which is where renderAuth kicks in.
$appPwGiven = (string)($_GET['app_password'] ?? $_POST['app_password'] ?? '');
if (strlen($appPwGiven) > 256) { http_response_code(400); exit('Invalid app password'); }
// The PWA manifest must be readable before the user has typed the app password
// (the browser fetches it on every navigation), so it's allowed past this gate.
$publicModes = ['icon', 'manifest'];
if ($APP_PASSWORD !== '' && !hash_equals($APP_PASSWORD, $appPwGiven)
    && isset($_GET['mode']) && !in_array($_GET['mode'], $publicModes, true)) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'app_password_required', 'hint' => $APP_PASSWORD_HINT]);
    exit;
}

// ## php-icon — installable PWAs need fetchable icon URLs, not just data: favicons
if (($_GET['mode'] ?? '') === 'icon') {
    $theme = (string)($_GET['theme'] ?? 'dark');
    $svg = $theme === 'light' ? $APP_ICON_SVG_LIGHT : $APP_ICON_SVG_DARK;
    header('Content-Type: image/svg+xml');
    header('Cache-Control: public, max-age=3600');
    echo $svg;
    exit;
}

// ## php-manifest — PWA manifest, name = $TITLE so installs adopt the configured app name
if (($_GET['mode'] ?? '') === 'manifest') {
    header('Content-Type: application/manifest+json');
    header('Cache-Control: no-cache');
    echo json_encode([
        'id'               => './',
        'name'             => $TITLE,
        'short_name'       => $TITLE,
        'start_url'        => './',
        'scope'            => './',
        'display'          => 'standalone',
        'background_color' => $PWA_THEME_COLOR_DARK,
        'theme_color'      => $PWA_THEME_COLOR_DARK,
        'icons' => [
            ['src' => $APP_ICON_MANIFEST . '&size=192', 'sizes' => '192x192', 'type' => 'image/svg+xml', 'purpose' => 'any'],
            ['src' => $APP_ICON_MANIFEST . '&size=512', 'sizes' => '512x512', 'type' => 'image/svg+xml', 'purpose' => 'any maskable'],
        ],
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
// ## php-adapter — Adapter base + Nextcloud / Local implementations
// Adapter contract: list($path, $password) returns
//   ['folders'=>[...], 'files'=>[...]]  on success,
//   ['_status'=>401]                    if auth required,
//   ['_status'=>$code, 'error'=>$msg]   on other failure.
// fetch($path, $password) streams response with Range + cache-validator passthrough.
// .sync-player.json holds per-folder base tones (dot-prefixed → hidden in most
// file browsers). The human-readable description lives next to it in readme.md
// so it doubles as the folder's README on GitHub/Nextcloud.
const SIDECAR = '.sync-player.json';
const README  = 'readme.md';

function audioRegex(array $audioExt): string {
    return '/\.(' . implode('|', $audioExt) . ')$/i';
}

// Streaming setup shared by both adapters' fetch(): disable buffering + add a
// Content-Disposition: attachment header when $download is set.
function prepareStream(): void {
    ini_set('zlib.output_compression', '0');
    while (ob_get_level()) ob_end_clean();
    header('X-Accel-Buffering: no');
}
function attachmentHeader(string $name): void {
    $ascii = preg_replace('/[^\x20-\x7e]/', '_', $name);
    header('Content-Disposition: attachment; filename="' . str_replace('"', '', $ascii) . '"; filename*=UTF-8\'\'' . rawurlencode($name));
}

abstract class Adapter {
    abstract public function id(): string;
    abstract public function cloudUrl(string $path): ?string;
    abstract public function canWrite(): bool;
    abstract public function list(string $path, string $password): array;
    abstract public function search(string $path, string $query, string $password): array;
    abstract public function fetch(string $path, string $password, bool $download = false): void;
    abstract public function loadMeta(string $path, string $password): array;
    abstract public function saveMeta(string $path, array $meta, string $password): array;
}

class NextcloudAdapter extends Adapter {
    private string $host;
    private string $defaultPw;
    private string $pwHint;
    public function __construct(private array $cfg, private array $audioExt) {
        $this->host = rtrim($cfg['host'], '/');
        $this->defaultPw = (string)($cfg['password'] ?? '');
        $this->pwHint    = (string)($cfg['password_hint'] ?? '');
    }
    public function id(): string { return 'nc:' . $this->cfg['token']; }
    public function canWrite(): bool { return !empty($this->cfg['can_write']); }
    private function pwOr(string $given): string { return $given !== '' ? $given : $this->defaultPw; }
    // Nextcloud's brute-force protection delays auth-touching responses by up to
    // ~25s after a few failed attempts on the IP. Total timeout must outlast that
    // or every list/fetch fails with curl 28 the moment the user mistypes once.
    private function curlBaseOptions(): array {
        return [
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_TIMEOUT => 30,
        ];
    }
    // Returns ['header' => &string, 'callback' => callable] for capturing the
    // X-Nextcloud-Bruteforce-Throttled header (presence = NC delayed this req).
    private function throttleCapture(string &$slot): callable {
        return function ($_c, $h) use (&$slot) {
            if (stripos($h, 'x-nextcloud-bruteforce-throttled:') === 0) {
                $slot = trim(substr($h, strlen('x-nextcloud-bruteforce-throttled:')));
            }
            return strlen($h);
        };
    }
    private function curlFailure($ch, int $code, string $throttled = '', string $op = ''): array {
        $err = trim((string)curl_error($ch));
        $total = curl_getinfo($ch, CURLINFO_TOTAL_TIME);
        if ($code === 401) {
            if ($throttled !== '' || $total > 5) error_log("syncplayer NC $op 401 throttled=$throttled time={$total}s");
            return ['_status' => 401, 'hint' => $this->pwHint, 'throttled' => $throttled !== ''];
        }
        if ($code < 200 || $code >= 400) {
            error_log("syncplayer NC $op failed code=$code curl_err=\"$err\" throttled=$throttled time={$total}s");
            return [
                '_status' => $code > 0 ? $code : 502,
                'error'   => $err !== '' ? $err : "Error: $code",
                'throttled' => $throttled !== '',
            ];
        }
        if ($total > 5) error_log("syncplayer NC $op slow code=$code throttled=$throttled time={$total}s");
        return [];
    }
    public function cloudUrl(string $path): ?string {
        return $this->host . '/s/' . rawurlencode($this->cfg['token']) . '?dir=' . rawurlencode($path);
    }
    private function davUrl(string $path): string {
        $clean = trim($path, '/');
        return $this->host . '/public.php/webdav' . ($clean ? '/' . implode('/', array_map('rawurlencode', explode('/', $clean))) : '');
    }
    private function sidecarUrl(string $path, string $name): string {
        $clean = trim($path, '/');
        return $this->davUrl(($clean ? $clean . '/' : '') . $name);
    }
    public function list(string $path, string $password): array {
        if (!$this->cfg['token']) return ['_status' => 500, 'error' => 'Nextcloud token not configured'];
        $pw = $this->pwOr($password);
        $throttled = '';
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $this->davUrl($path),
            CURLOPT_USERPWD => $this->cfg['token'] . ':' . $pw,
            CURLOPT_CUSTOMREQUEST => 'PROPFIND',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Depth: 1'],
            CURLOPT_HEADERFUNCTION => $this->throttleCapture($throttled),
        ] + $this->curlBaseOptions());
        $xml = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($fail = $this->curlFailure($ch, $code, $throttled, "list($path)")) return $fail;

        preg_match_all('#<d:response>(.*?)</d:response>#s', $xml, $rs);
        if (empty($rs[1])) return ['_status' => 502, 'error' => 'Invalid WebDAV response'];
        $base_path = '/public.php/webdav';
        $self = rtrim($path, '/') ?: '';
        $out = ['folders' => [], 'files' => [], 'attachments' => []];
        foreach ($rs[1] ?? [] as $r) {
            if (!preg_match('#<d:href>([^<]+)</d:href>#', $r, $hm)) continue;
            $rel = urldecode(str_replace($base_path, '', $hm[1]));
            if (rtrim($rel, '/') === $self || $rel === '') continue;
            $is_dir = strpos($r, '<d:collection') !== false;
            $name = basename(rtrim($rel, '/'));
            $lm = preg_match('#<d:getlastmodified>([^<]+)</d:getlastmodified>#', $r, $lmm) ? $lmm[1] : '';
            if ($is_dir) {
                $out['folders'][] = ['name' => $name, 'path' => rtrim($rel, '/'), 'lm' => $lm];
            } elseif (preg_match(audioRegex($this->audioExt), $name)) {
                $out['files'][] = ['name' => $name, 'path' => $rel, 'lm' => $lm];
            } elseif ($kind = attachmentKind($name)) {
                $out['attachments'][] = ['name' => $name, 'path' => $rel, 'lm' => $lm, 'kind' => $kind];
            }
        }
        foreach ($out as $k => $_) usort($out[$k], fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
        return $out;
    }
    public function search(string $path, string $query, string $password): array {
        if (!$this->cfg['token']) return ['_status' => 500, 'error' => 'Nextcloud token not configured'];
        $pw = $this->pwOr($password);
        $throttled = '';
        // PROPFIND Depth: infinity walks the full subtree in one round-trip. Some Nextcloud
        // instances disable this for public shares — they answer 403/405; we surface that.
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $this->davUrl($path),
            CURLOPT_USERPWD => $this->cfg['token'] . ':' . $pw,
            CURLOPT_CUSTOMREQUEST => 'PROPFIND',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Depth: infinity'],
            CURLOPT_HEADERFUNCTION => $this->throttleCapture($throttled),
        ] + $this->curlBaseOptions());
        $xml = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($code === 401) return ['_status' => 401, 'hint' => $this->pwHint, 'throttled' => $throttled !== ''];
        if ($code === 403 || $code === 405) return ['_status' => $code, 'error' => 'Recursive search disabled on this share.'];
        if ($fail = $this->curlFailure($ch, $code, $throttled, "search($path)")) return $fail;

        preg_match_all('#<d:response>(.*?)</d:response>#s', $xml, $rs);
        if (empty($rs[1])) return ['_status' => 502, 'error' => 'Invalid WebDAV response'];
        $base_path = '/public.php/webdav';
        $self = rtrim($path, '/') ?: '';
        $q = mb_strtolower($query);
        $out = ['folders' => []];
        $max = 200;
        foreach ($rs[1] ?? [] as $r) {
            if (count($out['folders']) >= $max) break;
            if (!preg_match('#<d:href>([^<]+)</d:href>#', $r, $hm)) continue;
            $rel = urldecode(str_replace($base_path, '', $hm[1]));
            if (rtrim($rel, '/') === $self || $rel === '') continue;
            if (strpos($r, '<d:collection') === false) continue;
            $name = basename(rtrim($rel, '/'));
            if (mb_stripos($name, $q) === false) continue;
            $lm = preg_match('#<d:getlastmodified>([^<]+)</d:getlastmodified>#', $r, $lmm) ? $lmm[1] : '';
            $out['folders'][] = ['name' => $name, 'path' => rtrim($rel, '/'), 'lm' => $lm];
        }
        usort($out['folders'], fn($a, $b) => strnatcasecmp($a['path'], $b['path']));
        return $out;
    }
    public function fetch(string $path, string $password, bool $download = false): void {
        if (!$this->cfg['token']) { http_response_code(500); return; }
        $pw = $this->pwOr($password);
        $clean = trim($path, '/');
        $req = $this->host . '/public.php/dav/files/' . rawurlencode($this->cfg['token'])
             . ($clean ? '/' . implode('/', array_map('rawurlencode', explode('/', $clean))) : '');

        prepareStream();
        if ($download) attachmentHeader(basename($clean) ?: 'download');

        $final = 0;
        $throttled = '';
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $req,
            CURLOPT_USERPWD => $this->cfg['token'] . ':' . $pw,
            CURLOPT_FOLLOWLOCATION => true,
            // No hard CURLOPT_TIMEOUT here — large files over slow links may
            // legitimately stream for minutes. CONNECTTIMEOUT still applies.
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_HTTPHEADER => array_filter([
                'Accept-Encoding: identity',
                !empty($_SERVER['HTTP_RANGE']) ? 'Range: ' . $_SERVER['HTTP_RANGE'] : null,
                !empty($_SERVER['HTTP_IF_NONE_MATCH']) ? 'If-None-Match: ' . $_SERVER['HTTP_IF_NONE_MATCH'] : null,
                !empty($_SERVER['HTTP_IF_MODIFIED_SINCE']) ? 'If-Modified-Since: ' . $_SERVER['HTTP_IF_MODIFIED_SINCE'] : null,
            ]),
            CURLOPT_HEADERFUNCTION => function ($_c, $h) use (&$final, &$throttled) {
                if (preg_match('#^HTTP/[\d.]+\s+(\d+)#', $h, $m)) {
                    $final = (int)$m[1];
                    if (($final >= 200 && $final < 400) || $final >= 400) http_response_code($final);
                    return strlen($h);
                }
                if (stripos($h, 'x-nextcloud-bruteforce-throttled:') === 0) {
                    $throttled = trim(substr($h, strlen('x-nextcloud-bruteforce-throttled:')));
                    // Forward to client so the SW/UI can react.
                    header('X-Nextcloud-Bruteforce-Throttled: ' . $throttled);
                }
                if ((($final >= 200 && $final < 300) || $final === 304)
                    && preg_match('/^(Content-Type|Content-Length|Accept-Ranges|Content-Range|Last-Modified|ETag|Cache-Control):/i', $h)) {
                    header(rtrim($h, "\r\n"));
                }
                return strlen($h);
            },
            CURLOPT_WRITEFUNCTION => function ($_c, $d) { echo $d; return strlen($d); },
        ]);
        curl_exec($ch);
        if ($final === 401 || $final === 0 || $final >= 500) {
            $err = trim((string)curl_error($ch));
            error_log("syncplayer NC fetch($path) final=$final curl_err=\"$err\" throttled=$throttled");
        }
    }
    // davGet returns [httpCode, body, etag]. ETag is captured from response headers
    // and reused as the optimistic-lock token for the next write.
    private function davGet(string $path, string $name, string $pw, string $accept = ''): array {
        $ch = curl_init();
        $etag = '';
        $opts = [
            CURLOPT_URL => $this->sidecarUrl($path, $name),
            CURLOPT_USERPWD => $this->cfg['token'] . ':' . $pw,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADERFUNCTION => function ($_c, $h) use (&$etag) {
                if (stripos($h, 'etag:') === 0) $etag = trim(substr($h, 5));
                return strlen($h);
            },
        ];
        if ($accept !== '') $opts[CURLOPT_HTTPHEADER] = ['Accept: ' . $accept];
        curl_setopt_array($ch, $opts);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        return [$code, is_string($body) ? $body : '', $etag];
    }
    // $expected: false = unconditional; null = require absent (If-None-Match:*); string = require ETag match.
    private function davPut(string $path, string $name, string $body, string $pw, string $contentType, mixed $expected): array {
        $headers = ['Content-Type: ' . $contentType];
        if ($expected === null) $headers[] = 'If-None-Match: *';
        elseif (is_string($expected) && $expected !== '') $headers[] = 'If-Match: ' . $expected;
        $newEtag = '';
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $this->sidecarUrl($path, $name),
            CURLOPT_USERPWD => $this->cfg['token'] . ':' . $pw,
            CURLOPT_CUSTOMREQUEST => 'PUT',
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => function ($_c, $h) use (&$newEtag) {
                if (stripos($h, 'etag:') === 0) $newEtag = trim(substr($h, 5));
                return strlen($h);
            },
        ]);
        curl_exec($ch);
        return [curl_getinfo($ch, CURLINFO_HTTP_CODE), $newEtag];
    }
    private function davDelete(string $path, string $name, string $pw, mixed $expected): int {
        $headers = [];
        if (is_string($expected) && $expected !== '') $headers[] = 'If-Match: ' . $expected;
        $ch = curl_init();
        $opts = [
            CURLOPT_URL => $this->sidecarUrl($path, $name),
            CURLOPT_USERPWD => $this->cfg['token'] . ':' . $pw,
            CURLOPT_CUSTOMREQUEST => 'DELETE',
            CURLOPT_RETURNTRANSFER => true,
        ];
        if ($headers) $opts[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $opts);
        curl_exec($ch);
        return curl_getinfo($ch, CURLINFO_HTTP_CODE);
    }
    public function loadMeta(string $path, string $password): array {
        if (!$this->cfg['token']) return ['_status' => 500, 'error' => 'Nextcloud token not configured'];
        $pw = $this->pwOr($password);

        [$jcode, $jbody, $jtag] = $this->davGet($path, SIDECAR, $pw, 'application/json');
        if ($jcode === 401) return ['_status' => 401, 'hint' => $this->pwHint];
        $tones = [];
        $sidecarVer = null;
        if ($jcode >= 200 && $jcode < 300) {
            $data = json_decode($jbody ?: '{}', true);
            if (!is_array($data)) return ['_status' => 502, 'error' => 'Invalid ' . SIDECAR];
            if (isset($data['tones']) && is_array($data['tones'])) $tones = $data['tones'];
            $sidecarVer = $jtag !== '' ? $jtag : false;
        } elseif ($jcode !== 404) {
            return ['_status' => $jcode, 'error' => "Error: $jcode"];
        }

        [$rcode, $rbody, $rtag] = $this->davGet($path, README, $pw);
        if ($rcode === 401) return ['_status' => 401, 'hint' => $this->pwHint];
        $description = '';
        $readmeVer = null;
        if ($rcode >= 200 && $rcode < 300) {
            $description = $rbody;
            $readmeVer = $rtag !== '' ? $rtag : false;
        } elseif ($rcode !== 404) {
            return ['_status' => $rcode, 'error' => "Error: $rcode"];
        }

        return [
            'description' => $description,
            'tones' => $tones,
            'versions' => ['readme' => $readmeVer, 'sidecar' => $sidecarVer],
        ];
    }
    // Maps a sidecar PUT/DELETE response code to an error array, or null on success.
    // $kind labels the conflict ('sidecar' | 'readme'); $allow404 lets DELETE shrug off "not there".
    private function mapWriteStatus(int $code, string $kind, bool $allow404 = false): ?array {
        if ($code === 401) return ['_status' => 401, 'hint' => $this->pwHint];
        if ($code === 412) return ['_status' => 409, 'error' => 'conflict', 'conflict' => $kind];
        if ($code >= 400 && !($allow404 && $code === 404)) return ['_status' => $code, 'error' => "Error: $code"];
        return null;
    }
    public function saveMeta(string $path, array $meta, string $password): array {
        if (!$this->canWrite()) return ['_status' => 403, 'error' => 'This share is read-only'];
        if (!$this->cfg['token']) return ['_status' => 500, 'error' => 'Nextcloud token not configured'];
        $pw = $this->pwOr($password);

        // Optimistic-lock tokens. Missing/force === no precondition.
        $force = !empty($meta['force']);
        $v = (is_array($meta['versions'] ?? null) && !$force) ? $meta['versions'] : [];
        $expSidecar = array_key_exists('sidecar', $v) ? $v['sidecar'] : false;
        $expReadme  = array_key_exists('readme',  $v) ? $v['readme']  : false;

        $tones = isset($meta['tones']) && is_array($meta['tones']) ? $meta['tones'] : [];
        $newSidecarVer = null;
        if (!empty($tones)) {
            $json = json_encode(['tones' => $tones], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            [$code, $tag] = $this->davPut($path, SIDECAR, $json . "\n", $pw, 'application/json', $expSidecar);
            if ($err = $this->mapWriteStatus($code, 'sidecar')) return $err;
            $newSidecarVer = $tag !== '' ? $tag : false;
        } elseif ($expSidecar !== null) {
            $code = $this->davDelete($path, SIDECAR, $pw, $expSidecar);
            if ($err = $this->mapWriteStatus($code, 'sidecar', true)) return $err;
        }

        $desc = (string)($meta['description'] ?? '');
        $newReadmeVer = null;
        if ($desc !== '') {
            [$code, $tag] = $this->davPut($path, README, $desc, $pw, 'text/markdown; charset=utf-8', $expReadme);
            if ($err = $this->mapWriteStatus($code, 'readme')) return $err;
            $newReadmeVer = $tag !== '' ? $tag : false;
        } elseif ($expReadme !== null) {
            $code = $this->davDelete($path, README, $pw, $expReadme);
            if ($err = $this->mapWriteStatus($code, 'readme', true)) return $err;
        }

        return ['ok' => true, 'versions' => ['readme' => $newReadmeVer, 'sidecar' => $newSidecarVer]];
    }
}

class LocalAdapter extends Adapter {
    private string $root;
    public function __construct(array $cfg, private array $audioExt) {
        $this->root = realpath($cfg['root']) ?: '';
    }
    public function id(): string { return 'local:' . md5($this->root); }
    public function cloudUrl(string $path): ?string { return null; }
    public function canWrite(): bool { return true; }

    // Returns absolute path within root, or null if outside / nonexistent.
    private function resolve(string $path): ?string {
        if (!$this->root) return null;
        $abs = realpath($this->root . '/' . ltrim($path, '/'));
        if (!$abs) return null;
        if ($abs !== $this->root && strpos($abs, $this->root . DIRECTORY_SEPARATOR) !== 0) return null;
        return $abs;
    }
    public function list(string $path, string $password): array {
        if (!$this->root) return ['_status' => 500, 'error' => 'Local root not configured'];
        $abs = $this->resolve($path);
        if (!$abs || !is_dir($abs)) return ['_status' => 404, 'error' => 'Not found'];
        $rel = rtrim('/' . trim($path, '/'), '/');
        $out = ['folders' => [], 'files' => [], 'attachments' => []];
        foreach (scandir($abs) as $name) {
            if ($name === '.' || $name === '..' || $name[0] === '.') continue;
            $full = $abs . '/' . $name;
            $childPath = $rel . '/' . $name;
            $lm = gmdate('D, d M Y H:i:s', filemtime($full)) . ' GMT';
            if (is_dir($full)) {
                $out['folders'][] = ['name' => $name, 'path' => $childPath, 'lm' => $lm];
            } elseif (preg_match(audioRegex($this->audioExt), $name)) {
                $out['files'][] = ['name' => $name, 'path' => $childPath, 'lm' => $lm];
            } elseif ($kind = attachmentKind($name)) {
                $out['attachments'][] = ['name' => $name, 'path' => $childPath, 'lm' => $lm, 'kind' => $kind];
            }
        }
        foreach ($out as $k => $_) usort($out[$k], fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
        return $out;
    }
    public function search(string $path, string $query, string $password): array {
        if (!$this->root) return ['_status' => 500, 'error' => 'Local root not configured'];
        $abs = $this->resolve($path);
        if (!$abs || !is_dir($abs)) return ['_status' => 404, 'error' => 'Not found'];
        $rel = rtrim('/' . trim($path, '/'), '/');
        $q = mb_strtolower($query);
        $out = ['folders' => []];
        $seen = [];
        $max = 200; $maxDepth = 8;
        $add = function(string $name, string $childPath, string $full) use (&$out, &$seen) {
            if (isset($seen[$childPath])) return;
            $seen[$childPath] = true;
            $out['folders'][] = ['name' => $name, 'path' => $childPath,
                'lm' => gmdate('D, d M Y H:i:s', filemtime($full)) . ' GMT'];
        };
        $walk = function(string $dir, string $relDir, int $depth) use (&$walk, &$out, $q, $max, $maxDepth, $add) {
            if (count($out['folders']) >= $max || $depth > $maxDepth) return;
            $entries = @scandir($dir);
            if (!$entries) return;
            foreach ($entries as $name) {
                if ($name === '.' || $name === '..' || $name[0] === '.') continue;
                $full = $dir . '/' . $name;
                if (!is_dir($full)) continue;
                $childPath = $relDir . '/' . $name;
                $hit = mb_stripos($name, $q) !== false;
                if (!$hit) {
                    $readme = $full . '/' . README;
                    if (is_file($readme)) {
                        $desc = (string)file_get_contents($readme);
                        if ($desc !== '' && mb_stripos($desc, $q) !== false) $hit = true;
                    }
                }
                if ($hit) {
                    $add($name, $childPath, $full);
                    if (count($out['folders']) >= $max) return;
                }
                $walk($full, $childPath, $depth + 1);
            }
        };
        $walk($abs, $rel, 0);
        usort($out['folders'], fn($a, $b) => strnatcasecmp($a['path'], $b['path']));
        return $out;
    }
    public function fetch(string $path, string $password, bool $download = false): void {
        $abs = $this->resolve($path);
        if (!$abs || !is_file($abs)) { http_response_code(404); return; }
        $size = filesize($abs);
        $mtime = filemtime($abs);
        $lm = gmdate('D, d M Y H:i:s', $mtime) . ' GMT';
        $etag = '"' . dechex($mtime) . '-' . dechex($size) . '"';

        $ifMod = $_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '';
        $ifNone = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
        if ($ifNone === $etag || ($ifMod && @strtotime($ifMod) >= $mtime)) {
            http_response_code(304);
            header("Last-Modified: $lm");
            header("ETag: $etag");
            return;
        }

        header('Content-Type: ' . $this->mimeFor($abs));
        header("Last-Modified: $lm");
        header("ETag: $etag");
        header('Accept-Ranges: bytes');
        header('Cache-Control: private, max-age=3600');
        if ($download) attachmentHeader(basename($abs));

        $start = 0; $end = $size - 1;
        if (!empty($_SERVER['HTTP_RANGE']) && preg_match('/bytes=(\d*)-(\d*)/', $_SERVER['HTTP_RANGE'], $m)) {
            if ($m[1] !== '') $start = (int)$m[1];
            if ($m[2] !== '') $end = (int)$m[2];
            if ($start > $end || $end >= $size) {
                http_response_code(416);
                header("Content-Range: bytes */$size");
                return;
            }
            http_response_code(206);
            header("Content-Range: bytes $start-$end/$size");
        }
        $length = $end - $start + 1;
        header("Content-Length: $length");

        prepareStream();

        $f = fopen($abs, 'rb');
        fseek($f, $start);
        $remaining = $length;
        while ($remaining > 0 && !feof($f)) {
            $chunk = fread($f, (int)min(8192, $remaining));
            echo $chunk;
            flush();
            $remaining -= strlen($chunk);
        }
        fclose($f);
    }
    // "$mtime.$size" doubles as our optimistic-lock token. clearstatcache() before
    // each stat so we don't see PHP's per-request cache after an external edit.
    private function localVer(string $file): ?string {
        clearstatcache(true, $file);
        return is_file($file) ? (filemtime($file) . '.' . filesize($file)) : null;
    }
    public function loadMeta(string $path, string $password): array {
        if (!$this->root) return ['_status' => 500, 'error' => 'Local root not configured'];
        $dir = $this->resolve($path);
        if (!$dir || !is_dir($dir)) return ['_status' => 404, 'error' => 'Not found'];

        $sidecar = $dir . '/' . SIDECAR;
        $readme  = $dir . '/' . README;
        $tones = [];
        if (is_file($sidecar)) {
            $data = json_decode((string)file_get_contents($sidecar), true);
            if (!is_array($data)) return ['_status' => 500, 'error' => 'Invalid ' . SIDECAR];
            if (isset($data['tones']) && is_array($data['tones'])) $tones = $data['tones'];
        }
        $description = is_file($readme) ? (string)file_get_contents($readme) : '';

        return [
            'description' => $description,
            'tones' => $tones,
            'versions' => ['readme' => $this->localVer($readme), 'sidecar' => $this->localVer($sidecar)],
        ];
    }
    public function saveMeta(string $path, array $meta, string $password): array {
        if (!$this->root) return ['_status' => 500, 'error' => 'Local root not configured'];
        $dir = $this->resolve($path);
        if (!$dir || !is_dir($dir)) return ['_status' => 404, 'error' => 'Not found'];

        $force = !empty($meta['force']);
        $v = (is_array($meta['versions'] ?? null) && !$force) ? $meta['versions'] : [];
        $expSidecar = array_key_exists('sidecar', $v) ? $v['sidecar'] : false;
        $expReadme  = array_key_exists('readme',  $v) ? $v['readme']  : false;

        $sidecar = $dir . '/' . SIDECAR;
        $readme  = $dir . '/' . README;

        // Conflict check: expected version must match on-disk now.
        if ($expSidecar !== false && $this->localVer($sidecar) !== $expSidecar) {
            return ['_status' => 409, 'error' => 'conflict', 'conflict' => 'sidecar'];
        }
        if ($expReadme !== false && $this->localVer($readme) !== $expReadme) {
            return ['_status' => 409, 'error' => 'conflict', 'conflict' => 'readme'];
        }

        $tones = isset($meta['tones']) && is_array($meta['tones']) ? $meta['tones'] : [];
        if (!empty($tones)) {
            $json = json_encode(['tones' => $tones], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($json === false || file_put_contents($sidecar, $json . "\n") === false) {
                return ['_status' => 500, 'error' => 'Failed to write ' . SIDECAR];
            }
        } elseif (is_file($sidecar)) {
            @unlink($sidecar);
        }

        $desc = (string)($meta['description'] ?? '');
        if ($desc !== '') {
            if (file_put_contents($readme, $desc) === false) {
                return ['_status' => 500, 'error' => 'Failed to write ' . README];
            }
        } elseif (is_file($readme)) {
            @unlink($readme);
        }

        return ['ok' => true, 'versions' => ['readme' => $this->localVer($readme), 'sidecar' => $this->localVer($sidecar)]];
    }
    private function mimeFor(string $path): string {
        return match(strtolower(pathinfo($path, PATHINFO_EXTENSION))) {
            'mp3' => 'audio/mpeg',
            'm4a', 'aac' => 'audio/mp4',
            'wav' => 'audio/wav',
            'ogg', 'oga' => 'audio/ogg',
            'opus' => 'audio/opus',
            'flac' => 'audio/flac',
            'webm', 'weba' => 'audio/webm',
            default => 'application/octet-stream',
        };
    }
}

$adapter = match($ADAPTER) {
    'nextcloud' => new NextcloudAdapter($NEXTCLOUD, $audio_ext),
    'local'     => new LocalAdapter($LOCAL, $audio_ext),
    default     => null,
};
if (!$adapter) { http_response_code(500); exit('Unknown adapter: ' . htmlspecialchars($ADAPTER)); }
// ## php-list — ?mode=list|search endpoints, folder + recursive search
// Adapter result → JSON response. Routes 401 (with hint), error (with status),
// or echoes the payload as-is. $extra is merged into the error body if present
// (e.g. {conflict: 'sidecar'}).
function jsonExit(array $out, array $extra = []): void {
    header('Content-Type: application/json');
    $throttled = !empty($out['throttled']);
    if ($throttled) header('X-Nextcloud-Bruteforce-Throttled: 1');
    if (($out['_status'] ?? 0) === 401) {
        http_response_code(401);
        echo json_encode([
            'error' => 'password_required',
            'hint'  => $out['hint'] ?? '',
            'throttled' => $throttled,
        ]);
        exit;
    }
    if (isset($out['error'])) {
        http_response_code($out['_status'] ?? 500);
        $body = ['error' => $out['error']] + $extra;
        if (isset($out['conflict'])) $body['conflict'] = $out['conflict'];
        if ($throttled) $body['throttled'] = true;
        echo json_encode($body);
        exit;
    }
    echo json_encode($out);
    exit;
}

// ?mode=list&path=... — list one folder. Returns audio files + sub-folders.
if (($_GET['mode'] ?? '') === 'list') {
    jsonExit($adapter->list($path, $password));
}

// ?mode=search&path=...&q=... — recursive folder search beneath $path. Folders only.
if (($_GET['mode'] ?? '') === 'search') {
    $q = trim((string)($_GET['q'] ?? ''));
    if ($q === '')                  jsonExit(['folders' => []]);
    if (mb_strlen($q) > 100)        jsonExit(['_status' => 400, 'error' => 'Query too long']);
    jsonExit($adapter->search($path, $q, $password));
}
// ## php-fetch — ?mode=fetch, file streaming with Range + cache validators
// ?mode=fetch&path=...[&download=1] — stream a file with Range + cache headers.
// download=1 adds Content-Disposition: attachment so the browser saves it.
if (($_GET['mode'] ?? '') === 'fetch') {
    $download = !empty($_GET['download']);
    $adapter->fetch($path, $password, $download);
    exit;
}
// ## php-meta — ?mode=load-meta|save-meta, readme.md + .sync-player.json
function isAudioFilename(string $name, array $audioExt): bool {
    return $name !== ''
        && $name === basename($name)
        && !str_contains($name, '/')
        && !str_contains($name, '\\')
        && preg_match(audioRegex($audioExt), $name);
}

function attachmentKind(string $name): ?string {
    if ($name === '' || $name !== basename($name) || str_contains($name, '/') || str_contains($name, '\\')) {
        return null;
    }
    if (preg_match('/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i', $name)) return 'image';
    if (preg_match('/\.pdf$/i', $name)) return 'pdf';
    return null;
}

// Client payload: { description: string, tones: { "<audio-filename>": { note: "G4" } } }
// Adapters split this across two files: tones → .sync-player.json, description → readme.md.
// freq is derived client-side from note; only the note is persisted.
function normalizeMetaPayload(mixed $raw, array $audioExt): array {
    if (!is_array($raw)) throw new InvalidArgumentException('Body must be a JSON object');
    $description = isset($raw['description']) ? trim((string)$raw['description']) : '';
    if (mb_strlen($description) > 2000) throw new InvalidArgumentException('description too long');
    $tonesIn = $raw['tones'] ?? [];
    if (!is_array($tonesIn)) throw new InvalidArgumentException('tones must be an object');
    $tones = [];
    foreach ($tonesIn as $name => $tone) {
        if (!is_string($name) || !isAudioFilename($name, $audioExt)) {
            throw new InvalidArgumentException('Invalid filename in tones map');
        }
        if (!is_array($tone)) throw new InvalidArgumentException("Invalid tone for {$name}");
        $note = isset($tone['note']) ? trim((string)$tone['note']) : '';
        if ($note === '' || !preg_match('/^[A-Ga-g][#b]?-?\d+$/', $note)) {
            throw new InvalidArgumentException("Invalid note for {$name}");
        }
        $tones[$name] = ['note' => $note];
    }
    // versions: optional per-file optimistic-lock tokens (string | null | absent).
    // force: optional bool, bypass version checks for a confirmed overwrite.
    $versions = [];
    if (isset($raw['versions']) && is_array($raw['versions'])) {
        foreach (['readme', 'sidecar'] as $k) {
            if (!array_key_exists($k, $raw['versions'])) continue;
            $val = $raw['versions'][$k];
            if ($val !== null && !is_string($val)) throw new InvalidArgumentException("Invalid versions.$k");
            $versions[$k] = $val;
        }
    }
    return ['description' => $description, 'tones' => $tones, 'versions' => $versions, 'force' => !empty($raw['force'])];
}

if (($_GET['mode'] ?? '') === 'load-meta') {
    jsonExit($adapter->loadMeta($path, $password));
}

if (($_GET['mode'] ?? '') === 'save-meta') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') jsonExit(['_status' => 405, 'error' => 'Method not allowed']);
    if (!$adapter->canWrite())                 jsonExit(['_status' => 403, 'error' => 'This source is read-only']);
    try {
        $raw = json_decode((string)file_get_contents('php://input'), true, 64, JSON_THROW_ON_ERROR);
        $meta = normalizeMetaPayload($raw, $audio_ext);
    } catch (JsonException|InvalidArgumentException $e) {
        jsonExit(['_status' => 400, 'error' => $e->getMessage()]);
    }
    $out = $adapter->saveMeta($path, $meta, $password);
    if (isset($out['error']) || ($out['_status'] ?? 0) === 401) jsonExit($out);
    jsonExit(['ok' => true, 'versions' => $out['versions'] ?? null]);
}
$title = basename(rtrim($path, '/')) ?: $TITLE;
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title><?php echo htmlspecialchars($title); ?></title>
<link rel="icon" href="<?php echo htmlspecialchars($APP_ICON_LIGHT, ENT_QUOTES); ?>" media="(prefers-color-scheme: light)">
<link rel="icon" href="<?php echo htmlspecialchars($APP_ICON_DARK, ENT_QUOTES); ?>" media="(prefers-color-scheme: dark)">
<link rel="icon" href="<?php echo htmlspecialchars($APP_ICON_DARK, ENT_QUOTES); ?>">
<link rel="manifest" href="?mode=manifest">
<meta name="theme-color" content="<?php echo htmlspecialchars($PWA_THEME_COLOR_LIGHT, ENT_QUOTES); ?>" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="<?php echo htmlspecialchars($PWA_THEME_COLOR_DARK, ENT_QUOTES); ?>" media="(prefers-color-scheme: dark)">
<meta id="meta-theme-color" name="theme-color" content="<?php echo htmlspecialchars($PWA_THEME_COLOR_DARK, ENT_QUOTES); ?>">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="<?php echo htmlspecialchars($TITLE); ?>">
<link rel="stylesheet" href="style.css?v=<?php echo file_exists(__DIR__."/style.css") ? filemtime(__DIR__."/style.css") : 0; ?>">
</head>
<body>
<!-- ## html-shell -->
<header>
    <button class="btn" id="back" title="Back" style="display:none" onclick="navUp()">
        <svg class="icon" viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
    </button>
    <div class="title-wrap">
        <div class="title" id="ti"><?php echo htmlspecialchars($TITLE); ?></div>
        <div class="net-ind" id="net-ind" hidden aria-live="polite"><span class="lbl">Offline</span></div>
    </div>
    <button class="btn" id="clear-demo" title="Clear current folder and choose another" style="display:none" onclick="clearDemoRoot()">
        <svg class="icon" viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2zm2 8h2l-4 4-4-4h2V9h4v3z"/></svg>
    </button>
    <button class="btn" id="help-btn" title="Keyboard shortcuts (?)" onclick="toggleHelp()">
        <svg class="icon" viewBox="0 0 24 24"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>
    </button>
    <button type="button" class="edit-chip" id="edit-chip" title="Done editing" aria-label="Done editing">
        <span class="edit-chip-dot" id="edit-chip-dot" aria-hidden="true"></span>
        <span class="edit-chip-lbl">Editing</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="btn" id="menu-btn" title="More" aria-haspopup="menu" aria-expanded="false" onclick="toggleMenu()">
        <svg class="icon" viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>
    </button>
</header>
<div id="help" class="help-pop" hidden>
    <h4>Keyboard shortcuts</h4>
    <dl>
        <dt><kbd>Space</kbd></dt><dd>Play / pause</dd>
        <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Seek 5 s</dd>
        <dt><kbd>Shift</kbd> + <kbd>←</kbd>/<kbd>→</kbd></dt><dd>Seek 10 s</dd>
        <dt><kbd>M</kbd></dt><dd>Mute</dd>
        <dt><kbd>R</kbd></dt><dd>Repeat</dd>
        <dt><kbd>?</kbd></dt><dd>Toggle this help</dd>
        <dt>Waveform</dt><dd>Click to seek</dd>
        <dt>Track speaker</dt><dd>Click to mute, <kbd>Shift</kbd>+click to solo</dd>
        <dt>Track volume</dt><dd><kbd>Shift</kbd>+drag to set all other tracks</dd>
    </dl>
    <p class="hint">Issues: contact <a href="mailto:vitus.schuhwerk@mailbox.org">vitus.schuhwerk@mailbox.org</a><br>or open one at <a href="https://github.com/schuhwerk/sync-player" target="_blank" rel="noopener">github.com/schuhwerk/sync-player</a></p>
</div>
<div id="menu" class="menu-pop" hidden role="menu" aria-label="More options">
    <button type="button" class="row on" id="menu-show-wf" role="menuitemcheckbox" aria-checked="true">
        <span class="lbl">Show waveforms</span>
        <span class="switch" aria-hidden="true"></span>
    </button>
    <button type="button" class="row" id="menu-stage" role="menuitemcheckbox" aria-checked="false">
        <span class="lbl">Stage</span>
        <span class="switch" aria-hidden="true"></span>
    </button>
    <p class="info" id="menu-stage-info">Walk around the mix — drag tracks and the listener; distance sets each track's volume.</p>
    <button type="button" class="row" id="menu-offline" role="menuitemcheckbox" aria-checked="false" hidden>
        <span class="lbl">Make available offline</span>
        <span class="switch" aria-hidden="true"></span>
    </button>
    <p class="info" id="menu-offline-info" hidden>Download all audio in this folder for offline playback.</p>
    <button type="button" class="row" id="menu-edit" role="menuitemcheckbox" aria-checked="false">
        <span class="lbl">Edit metadata</span>
        <span class="switch" aria-hidden="true"></span>
    </button>
    <p class="info" id="menu-edit-info">Changes are saved to the folder and visible to everyone using this app.</p>
    <button type="button" class="row" id="menu-inspect" role="menuitemcheckbox" aria-checked="false">
        <span class="lbl">Inspection logging</span>
        <span class="switch" aria-hidden="true"></span>
    </button>
    <p class="info" id="menu-inspect-info">Shows recent events in a floating panel, mirrors them to <code>console.debug</code>, and keeps an in-memory ring buffer — <code>SyncInspect.dump()</code>.</p>
    <hr>
    <a class="row" id="menu-cloud" href="#" target="_blank" rel="noopener" role="menuitem" hidden>
        <span class="lbl">Open externally</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.59 5H14V3zM5 5h6v2H5v12h12v-6h2v8H3V5h2z" fill="currentColor"/></svg>
    </a>
    <hr>
    <div class="seg-lbl">Theme</div>
    <div class="seg" id="theme-seg" role="radiogroup" aria-label="Theme">
        <button type="button" data-theme="auto"  role="radio">Auto</button>
        <button type="button" data-theme="light" role="radio">Light</button>
        <button type="button" data-theme="dark"  role="radio">Dark</button>
    </div>
    <p class="info" id="menu-version"></p>
</div>
<div id="status-banner" class="status-banner" data-level="info" hidden role="status" aria-live="polite"></div>
<div id="inspect-log" class="inspect-log" hidden aria-hidden="true"></div>
<div id="root"><div class="loading">Loading…</div></div>

<script>window.CFG = {
    adapterId:    <?php echo json_encode($adapter->id()); ?>,
    title:        <?php echo json_encode($TITLE); ?>,
    path:         <?php echo json_encode($path); ?>,
    audioExt:     <?php echo json_encode($audio_ext); ?>,
    cloudUrl:     <?php echo json_encode($adapter->cloudUrl($path)); ?>,
    canWrite:     <?php echo json_encode($adapter->canWrite()); ?>,
    buildVersion: <?php echo json_encode(date('Y-m-d H:i', filemtime(__DIR__.'/app.js'))); ?>,
    pw: ""
};</script>
<script src="app.js?v=<?php echo file_exists(__DIR__."/app.js") ? filemtime(__DIR__."/app.js") : 0; ?>"></script>
</body>
</html>
