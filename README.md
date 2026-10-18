# Hermes Mac plugin sync

Makes the Hermes Desktop plugins on the Mac match `plugins.txt`. Paste this into Terminal on the Mac:

```
curl -fsSL https://raw.githubusercontent.com/supporteraphina/hermes-mac-sync/main/sync.sh | bash
```

Then in Hermes press ⌘K and run **Reload desktop plugins**.

To add or drop a plugin, edit `plugins.txt` and run the command again.
