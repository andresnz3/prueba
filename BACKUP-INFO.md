# SoftVenta working tree backup

This branch captures the local repository snapshot without changing the original worktree.

- Source branch: release/v1.0.0-rc.6
- Source HEAD: 6c25b3aa8a617dfedcf7d67549308775391e4146
- Local commits ahead of the GitHub release branch at snapshot time: 7
- Modified tracked files copied: 61
- Safe untracked files copied: 131
- Excluded untracked/changed paths: 44
- Exclusions: ZIP bundles and checksum sidecars, active environment files, database dumps, image archives, and private key/credential files.
- `.env.example` files already tracked as templates remain; they are not active environment files.
- This is a backup of the current repository worktree, not a claim that its source tree exactly reproduces production images.
- `BACKUP-FILES.sha256` records SHA-256 hashes of the copied working-tree files (excluding itself).
