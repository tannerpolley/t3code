# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## Run commands from chat

In a project thread, select **Run** on a completed shell code block to run it on the
thread's environment. Output appears under the block. Enter a response and select **Send**
when the command asks for input. Recognized password prompts hide your typing; choose
**Hide input** for other secret prompts. **Stop** or Ctrl+C
interrupts the command. **Open in terminal** opens the same session in the terminal drawer.

After the command ends, its exit code and elapsed time appear beside the output. The thread
keeps the command and the last 200 lines of output, up to 16 KiB, so the result is available
after reloading and on your other devices. Each completed run is automatically included in
the agent's context on its next turn.
