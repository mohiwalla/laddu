# Built-in skills

How-to guides that ship with laddu, one folder each with a `SKILL.md`:

```
skills/<name>/SKILL.md
---
name: <name>
description: <what it does and when to use it>
---

Steps, commands, gotchas. Supporting files (scripts/, references/) can sit next to it.
```

Codex sees every skill's name and description, and reads the full `SKILL.md` only when a task
matches, so many skills cost little.

- **Built-in** (`agent-home/skills/`, committed): generic, for every deployment.
- **Team** (`agent-home/skills.local/`, git-ignored): your organization's own procedures.
- **Personal**: laddu writes these for each person in their container (`$CODEX_HOME/skills`).

All three apply from the next message; no restart. See docs/ARCHITECTURE.md (Skills).
