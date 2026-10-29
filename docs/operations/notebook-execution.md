# Notebook execution configuration

Notebook execution is an optional fork extension. The server attaches to an existing
project Jupyter Server; it does not install packages or launch Jupyter. The saved-output
viewer continues to work without configuration. Web and desktop workspace notebooks provide explicit Run, Interrupt, Restart and Save controls.
Attachments and unconfigured projects keep the saved-output viewer. Agent tools are a separate delivery phase.

A trusted server operator configures `<T3 home>/notebooks.json`, outside the workspace.
It is an array with one entry per canonical workspace root. For a thread using a Git worktree,
configure that worktree’s root; execution verifies its own working directory:

```json
[
  {
    "root": "/absolute/canonical/project",
    "url": "http://127.0.0.1:8891",
    "secretName": "project-jupyter",
    "kernelName": "python3",
    "interpreter": "/absolute/canonical/path/to/python",
    "imports": ["numpy"]
  }
]
```

`secretName` refers to the existing ServerSecretStore, whose raw UTF-8 token file is
`<userdata>/secrets/<secretName>.bin` (directory mode 0700, file mode 0600, no trailing
newline). Provision it through the trusted secret workflow or a local secure prompt.
Never put the token in `t3.json`, the profile, URLs, logs, or client configuration.
Dev's state directory can differ from production; use that server's configured userdata.

Only literal `http://127.0.0.1:<port>` endpoints are accepted, including a configured
base path when needed. Redirects, credentials, query strings and fragments are rejected.
Loopback refers to the T3 server host, including for remote clients. Jupyter must retain
its authentication. Workspace files cannot enable execution or select an endpoint.

Opening probes authenticated kernelspec availability without creating a kernel. Explicit
execution creates a T3-owned kernel and verifies its canonical `sys.executable`, canonical
working directory (the project root), and configured imports before running notebook code.
For uv overlay environments, configure the actual overlay interpreter reported by that
project's managed Jupyter environment. A mismatch fails explicitly; T3 does not fall back
to global Python. Shut down the owned kernel before changing profiles. Profiles are read
on use, so updating one requires no T3 restart.

The server journals owned kernel IDs in `<T3 home>/notebook-kernels.json`. After a crash,
it deletes only journaled IDs with the same trusted profile before creating fresh kernels.
A missing kernel is already reconciled. A changed profile, invalid journal or unavailable
endpoint blocks execution until the operator restores the matching configuration and
reconciles ownership. Never delete arbitrary kernels from Jupyter's list. A hard crash
between Jupyter creating a kernel and T3 recording its returned ID can leave an unrecorded
orphan; it cannot safely be identified as T3-owned automatically.

A new server epoch loses process-local drafts, execution requests and outcomes. Clients
must compare epochs and reload a snapshot; they must not replay uncertain execution.
Channel loss marks execution unknown and requires explicit shutdown/restart. Saved files
remain durable. Finalizers and idle cleanup delete kernels, never the shared Jupyter server.

Viewer subscriptions hold leases; unexpected detach allows 60 seconds for reconnect.
Explicit leases can be acquired/released by opaque lease ID. The final explicit close
schedules immediate shutdown; headless execution retains a 60-second save/reconnect grace
after completion. Viewed kernels idle for 15 minutes since execution are shut down.
Active runs are never stopped by these deadlines. Drafts remain bounded in server memory
after kernel shutdown. Later clients must release explicit leases when closing.

Save checks document revision and disk hash under the canonical notebook lock and replaces
the file through a same-directory temporary rename. A conflict retains the server draft.
External editors do not share the lock: an external write in the final hash-check/rename
window is a best-effort limitation, not a filesystem compare-and-swap guarantee.
Documents are limited to 8 MiB and 500 cells. Execution output retains the existing visible
truncation marker and continues draining after the limit. Unsupported saved JSON is kept.
