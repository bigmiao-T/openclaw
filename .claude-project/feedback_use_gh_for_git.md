---
name: Use gh for git push
description: User prefers using gh CLI for git operations instead of raw git push/SSH
type: feedback
---

Always use `gh` CLI for pushing to GitHub instead of raw `git push` or SSH.
Pattern: use gh auth token to authenticate git push when needed.

**Why:** User's environment has SSL issues with HTTPS and may not have SSH keys configured. gh auth is already set up and reliable.

**How to apply:** For pushing, use `GITHUB_TOKEN=$(gh auth token) git push https://x-access-token:$(gh auth token)@github.com/...` or other gh-based workflows.
