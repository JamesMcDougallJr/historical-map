# Corpus

Drop textbook PDFs, saved web pages (`.html`), or plain text/Markdown here and
run a detection pass — the `local-directory` source scans this directory.

Recognised: `.pdf`, `.txt`, `.md`, `.markdown`, `.html`, `.htm`. Anything else
is ignored rather than failed. Dotfiles and `node_modules`/`.git` are skipped.

Documents are identified by their path relative to this directory, so moving a
file makes it a new document. Change is detected by SHA-256 of the contents —
editing a file re-ingests only that file.

Override the location with `INGEST_CORPUS_DIR`.

The documents themselves are gitignored; only this README is tracked.
