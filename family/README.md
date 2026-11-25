# Family album — Release 1: private review viewer

This branch is development-only and based on the live master branch. Do not merge/deploy until all access tests pass.

## First release
- Dedicated Flask-Login named accounts (no registration), rate-limited sign-in, CSRF for login/logout.
- Private revision dashboard, 18-spread Revision 1 and 20-spread Revision 2 viewer.
- Authenticated image/PDF routes using X-Accel-Redirect. No images or PDF binaries in public Git.
- No uploads, editing, comments or public shared links yet.

## Environment and account creation (Linode)
1. Confirm the live Python environment has flask-login installed; add it to the deployed dependency manifest.
2. Confirm master remains the branch deployed from Linode.
3. Set FAMILY_DATA_DIR=/srv/family-album in the Gunicorn service environment. Keep the path outside the Git checkout and Nginx web root.
4. Use a strong production Flask secret at least 32 characters. Existing app reads WORLDCUP_SECRET_KEY; it currently has a dev fallback, which the family blueprint explicitly refuses.
5. Create /srv/family-album/revisions/revision-1/spreads and revision-2/spreads with restricted permissions.
6. Run python family/scripts/init_family.py init; then python family/scripts/init_family.py set-user nathan Nathan and set-user rachel Rachel. Password prompts are interactive (16+ characters). Never paste passwords into commands or Git.
7. Privately transfer each revision's review.pdf into revisions/revision-1/ and revisions/revision-2/. Optionally populate spread-01.jpg through spread-18.jpg (Rev 1), through spread-20.jpg (Rev 2).
8. Give Gunicorn access to SQLite and approved files; give the Nginx process read-only access to the revisions subdirectory, not to SQLite or originals.
9. Back up the database and review files off-server.

## Nginx HTTPS server configuration
Only the following internal location grants Nginx access to authorized files. NEVER remove internal.
```nginx
location ^~ /__family_private__/ {
    internal;
    alias /srv/family-album/revisions/;
    add_header Cache-Control "private, no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```
Make sure /family requests still pass to Gunicorn; check for conflicting static aliases. Test with sudo nginx -t, then reload only after validation.

## Security release checklist
- Anonymous /family/ redirects to login.
- Anonymous private PDF and spread routes do not return X-Accel-Redirect.
- Direct /__family_private__/revision-2/review.pdf is rejected by Nginx (not publicly served).
- Authenticated users can retrieve approved assets, but cannot access arbitrary filenames.
- Logout immediately invalidates session access.
- Login and logout require CSRF, bad logins are throttled.
- Missing FAMILY_DATA_DIR, DB or production secret fails with 503.
- No private images, previews, SQLite files, passwords or PDFs in the public repository or public static path.
- Off-server backups tested; no public staging with real personal photos.

## Notes
The existing art blueprint has its own separate shared password; this viewer does not reuse it. Existing Flask sessions use WORLDCUP_SECRET_KEY, so changing it requires planning.
Print masters stay offline for now. First release uploads only reduced-size review assets securely through SSH/SFTP.