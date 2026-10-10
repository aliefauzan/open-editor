"""PDF → plain text through pypdf (engine "Stages", ingest of `.pdf` documents).

Run as `python -I -m vox_py.doctext`. Request: `{ path }`. Result: `{ text, pages }`; pages are
joined with a blank line. `.txt`, `.md` and `.fountain` are read by the engine itself.
"""

from __future__ import annotations

from . import _tool

REQUEST: _tool.Spec = {"path": (str, True)}


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    path = _tool.existing_file(req["path"])

    from pypdf import PdfReader
    from pypdf.errors import DependencyError, FileNotDecryptedError, PdfReadError

    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            # An empty user password still opens some "encrypted" PDFs; anything else is refused.
            try:
                opened = reader.decrypt("")
            except DependencyError as exc:
                raise _tool.ToolError(
                    "TOOL_MISSING", f"PDF decryption support missing: {exc}"
                ) from exc
            except (FileNotDecryptedError, NotImplementedError):
                opened = 0
            if not opened:
                raise _tool.ToolError("DOC_ENCRYPTED", f"the PDF is password protected: {path}")
        total = len(reader.pages)
        texts = []
        for i, page in enumerate(reader.pages):
            texts.append((page.extract_text() or "").strip())
            _tool.progress((i + 1) / max(total, 1), f"page {i + 1} of {total}")
    except _tool.ToolError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, OSError) as exc:
        raise _tool.ToolError("DOC_UNREADABLE", f"cannot read the PDF: {exc}") from exc
    return {"text": "\n\n".join(t for t in texts if t), "pages": total}


if __name__ == "__main__":
    _tool.main(handle)
