# Todo

## Bugs

- **Tracks load twice on SWR cache hit**: when the folder listing is served from IDB cache first and the network response arrives with changed `lm` values, `applyFreshData` re-renders (destroys + recreates `SyncPlayer`), causing a second full load. Investigate whether the files/attachments `same()` check should ignore `lm`, or whether the fresh render should reuse the existing player if audio paths haven't changed.
