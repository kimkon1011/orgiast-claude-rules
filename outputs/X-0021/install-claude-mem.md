# Install claude-mem

Install claude-mem for Claude Code on this PC (cr568 / Windows 11).

## Steps

1. Install claude-mem globally:
```bash
npm install -g claude-mem
```

2. Verify installation:
```bash
claude-mem --version
```

3. Run setup:
```bash
claude-mem install
```

4. Check the config was created:
```bash
dir %USERPROFILE%\.claude-mem\
```

5. Check the database was initialized:
```bash
dir %USERPROFILE%\.claude-mem\claude-mem.db
```

## Notes
- This PC runs Windows 11, Node.js should be available
- claude-mem requires Node.js 20.19+ or 22.12+
- Storage is SQLite at ~/.claude-mem/claude-mem.db
- After installation, claude-mem hooks will automatically observe tool calls and save session context
