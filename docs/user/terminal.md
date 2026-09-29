# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

## Run a command from an agent's reply

A shell code block in an agent's reply (`bash`, `sh`, `zsh`, `shell`, `console` or
`terminal`) has a play button next to Copy. It runs the block right away, without
asking, in the thread's worktree or project folder on the environment that owns
the thread. The output appears under the block while it runs, and when the command
exits T3 Code sends the command, its exit code and the end of its output to the
agent. A busy agent gets it after its current work; it is never interrupted.

Each run is its own terminal; open it from the terminal button on the output. In
a `console` block only the lines that start with `$ ` run. Turn the button off in
**Settings → Customizations → Run button on shell code blocks**. Windows
environments do not offer it.
