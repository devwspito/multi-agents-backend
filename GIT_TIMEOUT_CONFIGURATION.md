# Git Timeout Configuration

## Overview

Git timeouts are now **OPT-IN** to prevent breaking working operations. By default, git operations will complete naturally without artificial time limits.

## Why This Change?

Previously, aggressive timeouts (15-30 seconds) were causing legitimate operations to fail on:
- Large repositories
- Slow network connections
- Repositories with large files/history

This was breaking a working system and causing more problems than it solved.

## How It Works Now

### Default Behavior (Timeouts DISABLED)
```bash
# No timeout applied - operations complete naturally
git push origin my-branch
git pull origin main
git fetch --all
```

### Enable Timeouts (Only When Needed)
If you're experiencing hanging git operations, you can enable timeouts:

```bash
export GIT_ENABLE_TIMEOUTS=true
npm run dev
```

### Timeout Values (When Enabled)
- **FETCH**: 2 minutes
- **PUSH**: 3 minutes
- **PULL**: 3 minutes
- **CLONE**: 5 minutes
- **LS_REMOTE**: 30 seconds
- **DEFAULT**: 2 minutes

These are generous values that should work for most repositories.

## When to Enable Timeouts

Enable timeouts ONLY if you experience:
- Git operations hanging indefinitely
- Credential prompt issues
- Network connectivity problems
- Remote repository not responding

## Best Practices

1. **Don't enable timeouts by default** - they can cause false positives
2. **Investigate the root cause** - hanging usually indicates auth or network issues
3. **Use environment variable** - easy to toggle on/off for debugging
4. **Monitor logs** - timeout messages will indicate if operations are failing

## Troubleshooting

If operations are timing out when enabled:
1. Check your network connection
2. Verify GitHub/Git credentials are configured
3. Try increasing timeout in code if needed
4. Consider if repository is too large (use shallow clone)

## Related Files

- `src/utils/safeGitExecution.ts` - Main implementation
- `.env` - Add `GIT_ENABLE_TIMEOUTS=true` to enable
