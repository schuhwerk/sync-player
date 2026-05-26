<?php
// Build the single-file dist/index.html (CLI only — refuses HTTP).
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

// Pull audio extensions out of php-config so the dist agrees with the server.
if (!preg_match('/\$audio_ext\s*=\s*\[(.*?)\];/s', $indexSrc, $m)) {
    fwrite(STDERR, "couldn't find \$audio_ext\n"); exit(1);
}
$audio_ext = [];
eval('$audio_ext = [' . $m[1] . '];');
$audioExtJson = json_encode($audio_ext, JSON_UNESCAPED_SLASHES);

// Scan dist/demo/ for audio files and previewable attachments. If any, embed a
// static manifest into CFG.demo so the dist can open them from GitHub Pages
// without folder-picking.
// Drag-drop still overrides (visitors can try their own folder after the demo).
$demoDir = "$root/dist/demo";
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

$distTitle = 'Sync Player';
$manifestIcon = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Crect%20width='100'%20height='100'%20rx='22'%20fill='%23c8410a'/%3E%3Ctext%20x='50'%20y='72'%20font-size='62'%20text-anchor='middle'%3E%F0%9F%8E%B5%3C/text%3E%3C/svg%3E";
$manifestJson = json_encode([
    'name'             => $distTitle,
    'short_name'       => $distTitle,
    'start_url'        => './',
    'scope'            => './',
    'display'          => 'standalone',
    'background_color' => '#0e1116',
    'theme_color'      => '#c8410a',
    'icons' => [
        ['src' => $manifestIcon, 'sizes' => 'any', 'type' => 'image/svg+xml', 'purpose' => 'any maskable'],
    ],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

$out = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>$distTitle</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Ctext%20y='.9em'%20font-size='90'%3E%F0%9F%8E%B5%3C/text%3E%3C/svg%3E">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#c8410a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="$distTitle">
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
    adapterId: 'browser-fs',
    path:      new URLSearchParams(location.search).get('path') || '/',
    audioExt:  $audioExtJson,
    cloudUrl:  null,
    canWrite:  false,
    pw:        '',
    demo:      $demoCfg
};
</script>
<script>
$appJs
</script>
</body>
</html>
HTML;

@mkdir("$root/dist");
$dest = "$root/dist/index.html";
file_put_contents($dest, $out);
file_put_contents("$root/dist/sw.js", $swJs);
file_put_contents("$root/dist/manifest.webmanifest", $manifestJson);

printf("wrote %s (%s bytes)\n", $dest, number_format(strlen($out)));
if ($demoAudioCount || $demoAttachmentCount) {
    printf(
        "  + embedded demo manifest: %d audio file(s), %d attachment(s) in dist/demo/\n",
        $demoAudioCount,
        $demoAttachmentCount,
    );
}
