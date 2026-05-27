<?php
// Build the single-file docs/index.html (CLI only — refuses HTTP).
//
// Strategy: inline style.css, pull the HTML body region out of index.php, then
// swap the trailing <script> block (which is PHP-driven) for a static CFG that
// points at SyncBackend, plus inlined adapters/browser-fs.js and app.js.
//
// One artifact, no PHP, no fetches — open it from anywhere, drop a folder, play.

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = __DIR__;

function read_or_die(string $path): string {
    $s = @file_get_contents($path);
    if ($s === false) { fwrite(STDERR, "missing: $path\n"); exit(1); }
    return $s;
}

$indexSrc    = read_or_die("$root/index.php");
$appJs       = read_or_die("$root/app.js");
$browserFsJs = read_or_die("$root/adapters/browser-fs.js");
$swJs        = read_or_die("$root/sw.js");
$cssContent  = read_or_die("$root/style.css");

// html-shell: from <!-- ## html-shell --> to </body> (no closing marker needed).
if (!preg_match('/<!-- ## html-shell -->(.*?)<\/body>/s', $indexSrc, $m)) {
    fwrite(STDERR, "html-shell marker not found\n"); exit(1);
}
$htmlRegion = trim($m[1]);

// Strip the PHP-driven <script> at the end of html-shell — we replace it below.
$htmlBody = preg_replace('/<script>window\.CFG.*$/s', '', $htmlRegion);

// Pull audio extensions out of php-config so the docs build agrees with the server.
if (!preg_match('/\$audio_ext\s*=\s*\[(.*?)\];/s', $indexSrc, $m)) {
    fwrite(STDERR, "couldn't find \$audio_ext\n"); exit(1);
}
$audio_ext = [];
eval('$audio_ext = [' . $m[1] . '];');
$audioExtJson = json_encode($audio_ext, JSON_UNESCAPED_SLASHES);

// Scan docs/demo/ for audio files and previewable attachments. If any, embed a
// static manifest into CFG.demo so the build can open them from GitHub Pages
// without folder-picking.
// Drag-drop still overrides (visitors can try their own folder after the demo).
$demoDir = "$root/docs/demo";
$demoCfg = 'null';
$demoAudioCount = 0;
$demoAttachmentCount = 0;
if (is_dir($demoDir)) {
    $audioRe = '/\.(' . implode('|', $audio_ext) . ')$/i';
    $attachmentMap = [
        'image' => '/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i',
        'pdf' => '/\.pdf$/i',
    ];
    $files = [];
    $attachments = [];
    foreach (scandir($demoDir) as $name) {
        if ($name[0] === '.' || !is_file("$demoDir/$name")) continue;
        $entry = [
            'name' => $name,
            'lm'   => gmdate('D, d M Y H:i:s', filemtime("$demoDir/$name")) . ' GMT',
        ];
        if (preg_match($audioRe, $name)) {
            $files[] = $entry;
            continue;
        }
        foreach ($attachmentMap as $kind => $re) {
            if (!preg_match($re, $name)) continue;
            $entry['kind'] = $kind;
            $attachments[] = $entry;
            break;
        }
    }
    if ($files || $attachments) {
        usort($files, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
        usort($attachments, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
        $readme = is_file("$demoDir/readme.md") ? (string)file_get_contents("$demoDir/readme.md") : '';
        $demoCfg = json_encode(['baseUrl' => 'demo/', 'files' => $files, 'attachments' => $attachments, 'readme' => $readme], JSON_UNESCAPED_SLASHES);
        $demoAudioCount = count($files);
        $demoAttachmentCount = count($attachments);
    }
}

// Version = max mtime of inlined sources — same sources → same version,
// so unchanged rebuilds don't trigger spurious SW re-installs.
$version = max(
    filemtime("$root/app.js"),
    filemtime("$root/style.css"),
    filemtime("$root/adapters/browser-fs.js"),
);
$buildDate = date('Y-m-d H:i', $version);

$docsTitle = 'Sync Player';
$pwaThemeColorLight = '#f3ecdc';
$pwaThemeColorDark = '#0e1116';
$appIconDarkSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='#0e1116'/><path d='M 50 22 A 28 28 0 1 1 22 50' fill='none' stroke='#ffb454' stroke-width='4' stroke-linecap='round'/><path d='M46 42 L58 50 L46 58 Z' fill='#ece4d0'/></svg>";
$appIconLightSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='#f3ecdc'/><path d='M 50 22 A 28 28 0 1 1 22 50' fill='none' stroke='#c8410a' stroke-width='4' stroke-linecap='round'/><path d='M46 42 L58 50 L46 58 Z' fill='#15110a'/></svg>";
$appIconDark = 'data:image/svg+xml,' . rawurlencode($appIconDarkSvg);
$appIconLight = 'data:image/svg+xml,' . rawurlencode($appIconLightSvg);
$manifestIconPath = 'pwa-icon.svg';
$manifestJson = json_encode([
    'id'               => './',
    'name'             => $docsTitle,
    'short_name'       => $docsTitle,
    'start_url'        => './',
    'scope'            => './',
    'display'          => 'standalone',
    'background_color' => $pwaThemeColorDark,
    'theme_color'      => $pwaThemeColorDark,
    'icons' => [
        ['src' => $manifestIconPath, 'sizes' => '192x192', 'type' => 'image/svg+xml', 'purpose' => 'any'],
        ['src' => $manifestIconPath, 'sizes' => '512x512', 'type' => 'image/svg+xml', 'purpose' => 'any maskable'],
    ],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

$out = <<<HTML
<!-- Sync Player — built v$version -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>$docsTitle</title>
<link rel="icon" href="$appIconLight" media="(prefers-color-scheme: light)">
<link rel="icon" href="$appIconDark" media="(prefers-color-scheme: dark)">
<link rel="icon" href="$appIconDark">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="$pwaThemeColorLight" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="$pwaThemeColorDark" media="(prefers-color-scheme: dark)">
<meta id="meta-theme-color" name="theme-color" content="$pwaThemeColorDark">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="$docsTitle">
<style>
$cssContent
</style>
</head>
<body>
$htmlBody
<script>
// Browser-fs adapter must load first so app.js sees window.SyncBackend on import.
$browserFsJs
</script>
<script>
window.CFG = {
    adapterId:    'browser-fs',
    path:         new URLSearchParams(location.search).get('path') || '/',
    audioExt:     $audioExtJson,
    cloudUrl:     null,
    canWrite:     false,
    buildVersion: '$buildDate',
    pw:           '',
    demo:         $demoCfg
};
</script>
<script>
$appJs
</script>
</body>
</html>
HTML;

@mkdir("$root/docs");
$dest = "$root/docs/index.html";
file_put_contents($dest, $out);
// Stamp CACHE_NAME with the build version so deploying a new build causes
// the SW to re-install and evict the stale offline cache automatically.
$swVersioned = str_replace(
    'const CACHE_NAME = CACHE_PREFIX;',
    "const CACHE_NAME = CACHE_PREFIX + '-v{$version}';",
    $swJs
);
file_put_contents("$root/docs/sw.js", $swVersioned);
file_put_contents("$root/docs/$manifestIconPath", $appIconDarkSvg);
file_put_contents("$root/docs/manifest.webmanifest", $manifestJson);

printf("wrote %s (%s bytes)\n", $dest, number_format(strlen($out)));
if ($demoAudioCount || $demoAttachmentCount) {
    printf(
        "  + embedded demo manifest: %d audio file(s), %d attachment(s) in docs/demo/\n",
        $demoAudioCount,
        $demoAttachmentCount,
    );
}
