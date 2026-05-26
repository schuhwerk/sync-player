<?php
// Sync Player config.
//
// Copy to config.php (which is .gitignored) and edit, OR set the matching
// SYNCPLAYER_* environment variables. Env wins over the file — handy on
// YunoHost's my_webapp_ynh, which exposes per-app env vars in its admin UI.
//
// Both layers are optional. With neither, the defaults in index.php apply.

return [
    'adapter' => 'local',                       // 'nextcloud' | 'local'

    // Shown in the browser tab and as the header label at the root folder.
    // (Sub-folders show their own name; this is just the root fallback.)
    'title' => 'Sync Player',

    // App-level access gate. Empty = no gate (anyone with the URL can listen).
    // If set, the data endpoints reject requests without the matching pw.
    'app_password'      => '',
    'app_password_hint' => '',                  // short phrase shown on the prompt

    'nextcloud' => [
        'host'  => 'https://th-koeln.sciebo.de',
        'token' => '',                          // public share token from /s/<token>
        // If the share itself is password-protected, you can pre-fill it here
        // and visitors won't be prompted. Leave empty to prompt instead.
        'password'      => '',
        'password_hint' => '',
        // Enable only when the public share allows upload/editing; this lets
        // Sync Player save _base_tones.json back through WebDAV PUT.
        'can_write'     => false,
    ],

    'local' => [
        'root' => __DIR__ . '/public',          // folder to serve
    ],
];
