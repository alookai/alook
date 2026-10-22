# Claude memory test record — v3 companion

Date: 2026-10-21. Stable 2.1.304, macOS arm64. Official artifact checksum: b9ac5374839f14abf3f1f45610637c332b5daee5ce0d1634726cef87aab78e6a.

Publication status: review attachment only. No public URL has been created. Publish this sanitized record beside the article and link it before claiming that readers can download the evidence.

## Scope and starting state

Separate binary and CLAUDE_CONFIG_DIR; empty test Git repo and configuration folder; default memory placement; no autoMemoryDirectory or autoMemoryEnabled override. Tools Read/Write/Edit only, project/local settings sources, strict empty MCP. Machine instruction ancestry was not fully isolated. No daily installation upgrade.

The article’s three-step interactive check is a reader procedure based on current documentation, not a transcript of our experiment. Below is the exact CLI harness used for the recorded test, with paths normalized. All tested prompts are here; the article no longer presents abbreviated prompts as the ones we ran.

```python

from pathlib import Path
import subprocess,os,json,sys
p=Path(__file__).parent.resolve(); env=os.environ.copy();env['CLAUDE_CONFIG_DIR']=str(p/'config')
name=sys.argv[1]
prompts={
 'save':f'This is a disposable memory experiment. Save this non-sensitive persistent project preference using auto memory: the demo review label is OPAL-742. You may write only under {p/"config"}. Do not modify any repository file or instruction file. Then report what file was saved. Do not claim a save unless the write succeeded.',
 'recall':'This is a fresh-session memory experiment. What review label should this demo project use? If it is unknown say UNKNOWN. Do not guess and do not search repository files. You may read your memory files if needed. Report the answer and distinguish any file you actually read from what was already available.',
 'correct':f'In this disposable memory experiment the previous OPAL-742 review label is retired. Update the saved project preference so the current review label is CEDAR-915. Write only under {p/"config"}. Do not modify repository or instruction files. Report actual changed files only.'}
args=[str(p/'bin/claude'),'-p',prompts[name],'--output-format','stream-json','--verbose','--tools','Read,Write,Edit','--allowedTools','Read,Write,Edit','--permission-mode','acceptEdits','--setting-sources','project,local','--strict-mcp-config','--mcp-config',str(p/'empty-mcp.json')]
with (p/(sys.argv[2]+'.jsonl')).open('w') as out,(p/(sys.argv[2]+'.stderr')).open('w') as err:
 try:r=subprocess.run(args,cwd=p/'repo',env=env,stdout=out,stderr=err,timeout=55);print('exit',r.returncode)
 except subprocess.TimeoutExpired:print('timeout after 55s')


```

## Evidence handling

Tool-call inputs, tool-result blocks and file snapshots are extracted from retained logs. Unrelated response greetings, machine instructions, credentials and environment variables are omitted. Paths are normalized; this is an evidence extract, not a complete transcript. originSessionId and timestamps are test-generated metadata.

## Current stable

### save-default

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_015a9nesQNmAhgKS2BLLqVHV",
    "name": "Read",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/MEMORY.md"
    }
  },
  {
    "type": "tool_result",
    "content": "File does not exist. Note: your current working directory is <test-root>/repo.",
    "is_error": true,
    "tool_use_id": "toolu_bdrk_015a9nesQNmAhgKS2BLLqVHV"
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01GduyQ9di51CY24jc779rRy",
    "name": "Write",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/demo-review-label.md",
      "content": "---\nname: demo-review-label\ndescription: The demo review label for this project is OPAL-742\nmetadata:\n  type: project\n---\n\nThe demo review label is OPAL-742.\n\n**Why:** The user set this as a persistent project preference (stated 2026-10-21, in a disposable memory experiment).\n\n**How to apply:** Use OPAL-742 whenever a demo review label is needed.\n"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01GduyQ9di51CY24jc779rRy",
    "type": "tool_result",
    "content": "File created successfully at: <test-root>/config/projects/<encoded-project>/memory/demo-review-label.md"
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_011PZ6MGagaEKRQWGqhYvgGY",
    "name": "Write",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/MEMORY.md",
      "content": "- [Demo review label](demo-review-label.md) — demo review label is OPAL-742\n"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_011PZ6MGagaEKRQWGqhYvgGY",
    "type": "tool_result",
    "content": "File created successfully at: <test-root>/config/projects/<encoded-project>/memory/MEMORY.md (file state is current in your context — no need to Read it back)"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "756434b4-dae6-4e48-b1b8-ab11b3148007",
    "answer_extract": "OPAL-742"
  }
]

```

### recall-default

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01ML3qJn9enVQ5GB6GTWsRVh",
    "name": "Read",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/demo-review-label.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01ML3qJn9enVQ5GB6GTWsRVh",
    "type": "tool_result",
    "content": "1\t---\n2\tname: demo-review-label\n3\tdescription: The demo review label for this project is OPAL-742\n4\tmetadata:\n5\t  node_type: memory\n6\t  type: project\n7\t  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007\n8\t  modified: 2026-10-21T03:38:09.753Z\n9\t---\n10\t\n11\tThe demo review label is OPAL-742.\n12\t\n13\t**Why:** The user set this as a persistent project preference (stated 2026-10-21, in a disposable memory experiment).\n14\t\n15\t**How to apply:** Use OPAL-742 whenever a demo review label is needed.\n16\t"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "4870485f-166b-4512-92ab-1fe773cad6e8",
    "answer_extract": "OPAL-742"
  }
]

```

### correct-default

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01A3ojtAptBSAVuir3KbTE4V",
    "name": "Read",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/demo-review-label.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01A3ojtAptBSAVuir3KbTE4V",
    "type": "tool_result",
    "content": "1\t---\n2\tname: demo-review-label\n3\tdescription: The demo review label for this project is OPAL-742\n4\tmetadata:\n5\t  node_type: memory\n6\t  type: project\n7\t  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007\n8\t  modified: 2026-10-21T03:38:09.753Z\n9\t---\n10\t\n11\tThe demo review label is OPAL-742.\n12\t\n13\t**Why:** The user set this as a persistent project preference (stated 2026-10-21, in a disposable memory experiment).\n14\t\n15\t**How to apply:** Use OPAL-742 whenever a demo review label is needed.\n16\t"
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01Vaerh4NiKkcr5piBviMwgS",
    "name": "Write",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/demo-review-label.md",
      "content": "---\nname: demo-review-label\ndescription: The current demo review label for this project is CEDAR-915 (OPAL-742 is retired)\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007\n  modified: 2026-10-21T00:00:00.000Z\n---\n\nThe current demo review label is CEDAR-915. The previous label, OPAL-742, is retired. Do not use it.\n\n**Why:** The user replaced OPAL-742 with CEDAR-915 on 2026-10-21, in a disposable memory experiment.\n\n**How to apply:** Use CEDAR-915 whenever a demo review label is needed.\n"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01Vaerh4NiKkcr5piBviMwgS",
    "type": "tool_result",
    "content": "The file <test-root>/config/projects/<encoded-project>/memory/demo-review-label.md has been updated successfully."
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01LS1uHMaKEUT3bVoja9ZJeS",
    "name": "Write",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/MEMORY.md",
      "content": "- [Demo review label](demo-review-label.md) — current demo review label is CEDAR-915 (OPAL-742 retired)\n"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01LS1uHMaKEUT3bVoja9ZJeS",
    "type": "tool_result",
    "content": "The file <test-root>/config/projects/<encoded-project>/memory/MEMORY.md has been updated successfully. (file state is current in your context — no need to Read it back)"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "5784872f-329a-4188-9da7-7e6188ea2553",
    "answer_extract": "CEDAR-915"
  }
]

```

### recall-corrected

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01E1FtoABR9bucmf8oWuxKUW",
    "name": "Read",
    "input": {
      "file_path": "<test-root>/config/projects/<encoded-project>/memory/demo-review-label.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01E1FtoABR9bucmf8oWuxKUW",
    "type": "tool_result",
    "content": "1\t---\n2\tname: demo-review-label\n3\tdescription: The current demo review label for this project is CEDAR-915 (OPAL-742 is retired)\n4\tmetadata:\n5\t  node_type: memory\n6\t  type: project\n7\t  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007\n8\t  modified: 2026-10-21T03:38:56.849Z\n9\t---\n10\t\n11\tThe current demo review label is CEDAR-915. The previous label, OPAL-742, is retired. Do not use it.\n12\t\n13\t**Why:** The user replaced OPAL-742 with CEDAR-915 on 2026-10-21, in a disposable memory experiment.\n14\t\n15\t**How to apply:** Use CEDAR-915 whenever a demo review label is needed.\n16\t"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "f8d72520-8ea7-4fe0-a16b-c1e677cbd60d",
    "answer_extract": "CEDAR-915"
  }
]

```

### recall-removed

```json

[
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "f7fa9d37-9484-4d66-9e3b-17851ed0f95a",
    "answer_extract": "UNKNOWN"
  }
]

```

### File snapshots

#### snapshots/after-correction/MEMORY.md

SHA256: c550fb5898c72a7b12239d306d6b1041efeb15e2ea60fa55552e7b7d861e2b8c

```markdown

- [Demo review label](demo-review-label.md) — current demo review label is CEDAR-915 (OPAL-742 retired)


```

#### snapshots/after-correction/demo-review-label.md

SHA256: 20c49da0c9de434450e4d5a30b41395c4f33dc5a7e76839d9e6ded576d14cee2

```markdown

---
name: demo-review-label
description: The current demo review label for this project is CEDAR-915 (OPAL-742 is retired)
metadata:
  node_type: memory
  type: project
  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007
  modified: 2026-10-21T03:38:56.849Z
---

The current demo review label is CEDAR-915. The previous label, OPAL-742, is retired. Do not use it.

**Why:** The user replaced OPAL-742 with CEDAR-915 on 2026-10-21, in a disposable memory experiment.

**How to apply:** Use CEDAR-915 whenever a demo review label is needed.


```

#### snapshots/after-removal/MEMORY.md

SHA256: 37e414b60756a00a80760f95693fc6fd21936487334ff9a78f0464ba98596afc

```markdown

# Disposable test memory

No saved project preferences.


```

#### snapshots/after-save/MEMORY.md

SHA256: 0b421e28e4c9834fe214b4a5fc18232a2d75dd36f023dcdc181df91d04c4056d

```markdown

- [Demo review label](demo-review-label.md) — demo review label is OPAL-742


```

#### snapshots/after-save/demo-review-label.md

SHA256: 185980317c82e6a1b6677193702231e730b85f289d047a47fb7c76b408713620

```markdown

---
name: demo-review-label
description: The demo review label for this project is OPAL-742
metadata:
  node_type: memory
  type: project
  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007
  modified: 2026-10-21T03:38:09.753Z
---

The demo review label is OPAL-742.

**Why:** The user set this as a persistent project preference (stated 2026-10-21, in a disposable memory experiment).

**How to apply:** Use OPAL-742 whenever a demo review label is needed.


```

#### snapshots/removed-demo-review-label.md

SHA256: 20c49da0c9de434450e4d5a30b41395c4f33dc5a7e76839d9e6ded576d14cee2

```markdown

---
name: demo-review-label
description: The current demo review label for this project is CEDAR-915 (OPAL-742 is retired)
metadata:
  node_type: memory
  type: project
  originSessionId: 756434b4-dae6-4e48-b1b8-ab11b3148007
  modified: 2026-10-21T03:38:56.849Z
---

The current demo review label is CEDAR-915. The previous label, OPAL-742, is retired. Do not use it.

**Why:** The user replaced OPAL-742 with CEDAR-915 on 2026-10-21, in a disposable memory experiment.

**How to apply:** Use CEDAR-915 whenever a demo review label is needed.


```

## Earlier custom-directory test 2.1.185

### save

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01Urw4FPHXvF13AU7vL9eThA",
    "name": "Write",
    "input": {
      "file_path": "<old-test-root>/memory/project_demo_review_label.md",
      "content": "---\nname: project-demo-review-label\ndescription: Demo review label identifier for the project\nmetadata:\n  type: project\n---\n\nDemo review label: OPAL-742\n\n**Why:** Persistent project preference for tracking demo reviews.\n\n**How to apply:** Use this label when referencing or tagging demo review work in the project.\n"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01Urw4FPHXvF13AU7vL9eThA",
    "type": "tool_result",
    "content": "File created successfully at: <old-test-root>/memory/project_demo_review_label.md (file state is current in your context — no need to Read it back)"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "25f99130-085d-452e-b0e1-31a82b8f78bf",
    "answer_extract": null
  }
]

```

### recall-before-correction

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01JJCaKBgnaK1nRHzEeDADAi",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory/MEMORY.md"
    }
  },
  {
    "type": "tool_result",
    "content": "File does not exist. Note: your current working directory is <old-test-root>/repo.",
    "is_error": true,
    "tool_use_id": "toolu_bdrk_01JJCaKBgnaK1nRHzEeDADAi"
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_019mA8xDZMiFginpQNBMaxmw",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory"
    }
  },
  {
    "type": "tool_result",
    "content": "EISDIR: illegal operation on a directory, read '<old-test-root>/memory'",
    "is_error": true,
    "tool_use_id": "toolu_bdrk_019mA8xDZMiFginpQNBMaxmw"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "32f0a8e3-4a94-4500-8ba0-463b8fc99dd8",
    "answer_extract": "UNKNOWN"
  }
]

```

### recall-after-index

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01NS5sESVFccNqkbMp4J1n7x",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory/project_demo_review_label.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01NS5sESVFccNqkbMp4J1n7x",
    "type": "tool_result",
    "content": "1\t---\n2\tname: project-demo-review-label\n3\tdescription: Demo review label identifier for the project\n4\tmetadata: \n5\t  node_type: memory\n6\t  type: project\n7\t  originSessionId: 25f99130-085d-452e-b0e1-31a82b8f78bf\n8\t---\n9\t\n10\tDemo review label: OPAL-742\n11\t\n12\t**Why:** Persistent project preference for tracking demo reviews.\n13\t\n14\t**How to apply:** Use this label when referencing or tagging demo review work in the project.\n15\t"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "db9fbbfe-251c-4e5d-95b6-70a39bf254e0",
    "answer_extract": "OPAL-742"
  }
]

```

### correct

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_019XUsFv7wrUm2U7WNMUzheQ",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory/project_demo_review_label.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_019XUsFv7wrUm2U7WNMUzheQ",
    "type": "tool_result",
    "content": "1\t---\n2\tname: project-demo-review-label\n3\tdescription: Demo review label identifier for the project\n4\tmetadata: \n5\t  node_type: memory\n6\t  type: project\n7\t  originSessionId: 25f99130-085d-452e-b0e1-31a82b8f78bf\n8\t---\n9\t\n10\tDemo review label: OPAL-742\n11\t\n12\t**Why:** Persistent project preference for tracking demo reviews.\n13\t\n14\t**How to apply:** Use this label when referencing or tagging demo review work in the project.\n15\t"
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01CaGeQd6xHo6nyhfNBjUtUu",
    "name": "Edit",
    "input": {
      "replace_all": false,
      "file_path": "<old-test-root>/memory/project_demo_review_label.md",
      "old_string": "Demo review label: OPAL-742",
      "new_string": "Demo review label: CEDAR-915"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01CaGeQd6xHo6nyhfNBjUtUu",
    "type": "tool_result",
    "content": "The file <old-test-root>/memory/project_demo_review_label.md has been updated successfully. (file state is current in your context — no need to Read it back)"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "71e0fa49-1825-4048-8f65-f1f9226405db",
    "answer_extract": null
  }
]

```

### recall-after-correction

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01JpZmSGbTFmS4NNqr27smwh",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory/project_demo_review_label.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01JpZmSGbTFmS4NNqr27smwh",
    "type": "tool_result",
    "content": "1\t---\n2\tname: project-demo-review-label\n3\tdescription: Demo review label identifier for the project\n4\tmetadata: \n5\t  node_type: memory\n6\t  type: project\n7\t  originSessionId: 25f99130-085d-452e-b0e1-31a82b8f78bf\n8\t---\n9\t\n10\tDemo review label: CEDAR-915\n11\t\n12\t**Why:** Persistent project preference for tracking demo reviews.\n13\t\n14\t**How to apply:** Use this label when referencing or tagging demo review work in the project.\n15\t"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "c2865614-53f5-4501-9058-f87105a79a1d",
    "answer_extract": "CEDAR-915"
  }
]

```

### recall-after-removal

```json

[
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01LxyT3GQaDSMvCKS6kAMhFE",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory/MEMORY.md"
    }
  },
  {
    "tool_use_id": "toolu_bdrk_01LxyT3GQaDSMvCKS6kAMhFE",
    "type": "tool_result",
    "content": "1\t# Demo memory index\n2\t\n3\tNo saved test preferences.\n4\t"
  },
  {
    "type": "tool_use",
    "id": "toolu_bdrk_01SaGPhsxfdC1Q7YL9g9s8ir",
    "name": "Read",
    "input": {
      "file_path": "<old-test-root>/memory"
    }
  },
  {
    "type": "tool_result",
    "content": "EISDIR: illegal operation on a directory, read '<old-test-root>/memory'",
    "is_error": true,
    "tool_use_id": "toolu_bdrk_01SaGPhsxfdC1Q7YL9g9s8ir"
  },
  {
    "type": "result_status",
    "is_error": false,
    "session_id": "a7edcb75-aa2e-47ff-97e6-58f34e713c40",
    "answer_extract": "UNKNOWN"
  }
]

```

### File snapshots

#### snapshot-after-save/project_demo_review_label.md

SHA256: f6437758e5a221a318dc85cecbbacf41002c455c63febfc07e73a1d4e00120f2

```markdown

---
name: project-demo-review-label
description: Demo review label identifier for the project
metadata: 
  node_type: memory
  type: project
  originSessionId: 25f99130-085d-452e-b0e1-31a82b8f78bf
---

Demo review label: OPAL-742

**Why:** Persistent project preference for tracking demo reviews.

**How to apply:** Use this label when referencing or tagging demo review work in the project.


```

#### snapshot-after-correction/MEMORY.md

SHA256: 6cd2b9d20d851b8c26a2f9137031b0c274c2700e21abd6f75fb948a4f104de56

```markdown

# Demo memory index

- Review label preference: [project_demo_review_label.md](project_demo_review_label.md)


```

#### snapshot-after-correction/project_demo_review_label.md

SHA256: 2911776542dc179732b4ae6ed428f51986f1b892766a2d327d2baa956f164520

```markdown

---
name: project-demo-review-label
description: Demo review label identifier for the project
metadata: 
  node_type: memory
  type: project
  originSessionId: 25f99130-085d-452e-b0e1-31a82b8f78bf
---

Demo review label: CEDAR-915

**Why:** Persistent project preference for tracking demo reviews.

**How to apply:** Use this label when referencing or tagging demo review work in the project.


```

## Author interventions

Current release: after the corrected recall, the author moved demo-review-label.md out of active memory and replaced MEMORY.md with a no-preferences index. No manual intervention between current save and first recall. Earlier release: author added a missing index pointer before the successful recall. Both removals were test-file edits, not privacy-erasure demonstrations.

## Review claims

Current correction used Write for topic and index, not Edit. The earlier correction provides the Edit event. The fresh current recalls directly read the topic. Startup index injection is model-reported, not independently established. Index itself contains the answer; topic read is established, exclusive causal source is not.
